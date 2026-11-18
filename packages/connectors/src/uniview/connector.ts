import type { Logger } from "@valtrexia/core/server";
import type { z } from "zod";
import { InvalidResponseError } from "../errors";
import { createHttpClient, type HttpClient, type HttpClientOptions, type Query } from "../http";
import type {
  Connector,
  NormalizedStatus,
  VendorAsset,
  VendorClient,
  VendorResult,
} from "../types";
import type { UniviewCredentials } from "./credentials";
import { normalizeUniviewStatus } from "./normalize";
import {
  parseUniviewTimestamp,
  univiewApplianceSchema,
  univiewAssetSchema,
  univiewBackupSchema,
  univiewCustomerSchema,
  type UniviewAppliance,
  type UniviewAsset,
  type UniviewCustomer,
} from "./schema";
import { fetchUniviewToken, type TokenOptions } from "./token";

/** UniView's public API, from its specification's `servers`. Fixed: never taken from input. */
export const UNIVIEW_API_BASE_URL = "https://public-api.backup.net";

/**
 * Items per page. 50 is the documented default; asking for more risks a
 * silently capped page being taken for the last one.
 */
export const UNIVIEW_PAGE_SIZE = 50;

export interface UniviewConnectorOptions extends Pick<
  HttpClientOptions,
  "fetch" | "logger" | "sleep" | "random" | "maxRetries"
> {
  /** Overrides the API and token addresses. Tests only. */
  baseUrl?: string;
  tokenUrl?: TokenOptions["tokenUrl"];
}

interface Snapshot {
  customers: UniviewCustomer[];
  appliances: Map<string, UniviewAppliance>;
  assets: UniviewAsset[];
}

/**
 * Kaseya UniView (Unitrends), read-only.
 *
 * Built from Kaseya's published OpenAPI specification for the UniView public
 * API. Clients are UniView customers; assets are the machines and other
 * items protected by Unitrends appliances; results are individual backups,
 * which UniView keeps as a history and can filter by start time, so a first
 * sync reaches back as far as `since` asks.
 *
 *   POST login.backup.net/connect/token   client credentials → access token
 *   GET  /v1/customers
 *   GET  /v1/appliances                    to name the appliance protecting each asset
 *   GET  /v1/assets
 *   GET  /v1/backups?start_time_from=…
 *
 * UniView does not report backup schedules, nor whether an asset is paused
 * or retired, so those are left to the MSP's own settings.
 *
 * One instance serves one sync: one token, and each list fetched once.
 */
export class UniviewConnector implements Connector {
  readonly vendor = "kaseya_uniview" as const;
  readonly #credentials: UniviewCredentials;
  readonly #options: UniviewConnectorOptions;
  readonly #logger: Logger | undefined;
  #http: Promise<HttpClient> | undefined;
  #snapshot: Promise<Snapshot> | undefined;

  constructor(credentials: UniviewCredentials, options: UniviewConnectorOptions = {}) {
    this.#credentials = credentials;
    this.#options = options;
    this.#logger = options.logger;
  }

  /** A token and one customer: proves the credentials and their right to read. */
  async testConnection(): Promise<void> {
    await (await this.#client()).getJson("v1/customers", { page_number: 1, page_size: 1 });
  }

  async listClients(): Promise<VendorClient[]> {
    const { customers } = await this.#load();
    return customers
      .map((customer) => ({
        vendorClientId: customer.id,
        name: customer.name?.trim() || `Customer ${customer.id.slice(0, 8)}`,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "en"));
  }

  async listAssets(clientId: string): Promise<VendorAsset[]> {
    const { assets, appliances } = await this.#load();
    return assets
      .filter((asset) => asset.customer_id === clientId)
      .map((asset) => {
        const appliance = asset.asset_tag ? appliances.get(asset.asset_tag) : undefined;
        return {
          vendorAssetId: asset.key,
          vendorClientId: clientId,
          name: asset.name?.trim() || asset.key,
          type: (asset.type?.trim() || "asset").toLowerCase(),
          deviceName: appliance?.name?.trim() || asset.asset_tag || null,
          isPaused: false,
          isArchived: false,
          expectedFrequencyHours: null,
        };
      });
  }

  async listResults(since: Date): Promise<VendorResult[]> {
    const items = await this.#collect("v1/backups", univiewBackupSchema, {
      start_time_from: since.toISOString(),
      order_by: "start_time",
      order_direction: "asc",
    });
    const results = new Map<string, VendorResult>();
    for (const backup of items) {
      const startedAt = parseUniviewTimestamp(backup.start_time);
      if (!startedAt || startedAt < since) continue;
      const running = backup.status === "InProgress";
      const result: VendorResult = {
        // UniView gives a backup no id of its own; its asset, type and start
        // time identify it, and stay the same while it runs and after.
        vendorResultId: `${backup.type?.trim() || "backup"}:${startedAt.toISOString()}`,
        vendorAssetId: backup.asset_key,
        startedAt,
        endedAt: running ? null : (parseUniviewTimestamp(backup.complete_time) ?? null),
        vendorStatusRaw: backup.status ?? "Unknown",
        message: describeBackup(backup.type, backup.replication_status),
        screenshotVerified: null,
        rawPayload: backup,
      };
      results.set(`${result.vendorAssetId}|${result.vendorResultId}`, result);
    }
    return [...results.values()];
  }

  normalizeStatus(raw: unknown): NormalizedStatus {
    return normalizeUniviewStatus(raw);
  }

  #client(): Promise<HttpClient> {
    this.#http ??= (async () => {
      const token = await fetchUniviewToken(this.#credentials, {
        ...(this.#options.fetch ? { fetch: this.#options.fetch } : {}),
        ...(this.#logger ? { logger: this.#logger } : {}),
        ...(this.#options.sleep ? { sleep: this.#options.sleep } : {}),
        ...(this.#options.maxRetries !== undefined ? { maxRetries: this.#options.maxRetries } : {}),
        ...(this.#options.tokenUrl ? { tokenUrl: this.#options.tokenUrl } : {}),
      });
      const { fetch, logger, sleep, random, maxRetries, baseUrl } = this.#options;
      return createHttpClient({
        baseUrl: baseUrl ?? UNIVIEW_API_BASE_URL,
        // Read from a closure per request; the token is not kept on an object.
        headers: () => ({ authorization: `Bearer ${token}` }),
        // Kaseya does not publish rate limits; stay gentle.
        maxConcurrency: 2,
        ...(fetch ? { fetch } : {}),
        ...(logger ? { logger } : {}),
        ...(sleep ? { sleep } : {}),
        ...(random ? { random } : {}),
        ...(maxRetries !== undefined ? { maxRetries } : {}),
      });
    })();
    return this.#http;
  }

  #load(): Promise<Snapshot> {
    this.#snapshot ??= (async () => {
      const [customers, appliances, assets] = await Promise.all([
        // A fixed order on a unique column keeps pages from overlapping.
        this.#collect("v1/customers", univiewCustomerSchema, {
          order_by: "id",
          order_direction: "asc",
        }),
        this.#collect("v1/appliances", univiewApplianceSchema, {
          order_by: "asset_tag",
          order_direction: "asc",
        }),
        this.#collect("v1/assets", univiewAssetSchema, { order_by: "key", order_direction: "asc" }),
      ]);
      return {
        customers,
        appliances: new Map(
          appliances.flatMap((appliance) =>
            appliance.asset_tag ? [[appliance.asset_tag, appliance] as const] : [],
          ),
        ),
        assets,
      };
    })();
    return this.#snapshot;
  }

  /** Every page of a list, keeping the items that parse. */
  async #collect<T>(path: string, schema: z.ZodType<T>, query: Query = {}): Promise<T[]> {
    const http = await this.#client();
    const parsed: T[] = [];
    let unreadable = 0;
    const maxPages = 2000;
    for (let page = 1; page <= maxPages; page += 1) {
      const body = await http.getJson(path, {
        ...query,
        page_number: page,
        page_size: UNIVIEW_PAGE_SIZE,
      });
      if (!Array.isArray(body)) throw new InvalidResponseError(`${path} is not a list`);
      for (const item of body) {
        const result = schema.safeParse(item);
        if (result.success) parsed.push(result.data);
        else unreadable += 1;
      }
      if (body.length < UNIVIEW_PAGE_SIZE) {
        if (unreadable > 0) {
          this.#logger?.warn({ path, unreadable }, "skipped unreadable UniView items");
        }
        return parsed;
      }
    }
    throw new InvalidResponseError(`pagination of ${path} did not end after ${maxPages} pages`);
  }
}

/** A short note about a backup worth showing beside its status: its type, and a failed replication. */
function describeBackup(type: string | null | undefined, replication: string | null | undefined) {
  const parts = [
    type?.trim() ? `${type.trim()} backup` : null,
    replication === "Failed" ? "Replication to the target failed." : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(". ").replace(/\.\./g, ".") : null;
}
