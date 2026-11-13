import type { Logger } from "@valtrexia/core/server";
import { InvalidResponseError, VendorError } from "../errors";
import { collectPages, type HttpClient, type Page } from "../http";
import type {
  Connector,
  NormalizedStatus,
  VendorAsset,
  VendorClient,
  VendorResult,
} from "../types";
import { createDattoClient, type DattoClientOptions } from "./client";
import type { DattoCredentials } from "./credentials";
import { dattoMessage, normalizeDattoStatus, screenshotOutcome } from "./normalize";
import {
  dattoAssetSchema,
  dattoBackupSchema,
  dattoDeviceSchema,
  dattoPageSchema,
  parseDattoTimestamp,
  type DattoAsset,
  type DattoDevice,
} from "./schema";

/** Devices and assets requested per page. Kept modest; Datto's maximum is unverified. */
const PAGE_SIZE = 50;

/**
 * Serial numbers go into a URL path. Anything that is not a plain token is
 * refused rather than encoded, so a hostile or corrupt value can never turn
 * `device/{serial}/asset` into a different path.
 */
const SAFE_SERIAL = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,63}$/;

interface DeviceAssets {
  device: DattoDevice;
  assets: DattoAsset[];
}

/**
 * Datto BCDR, read-only.
 *
 * Datto has no "results since" endpoint. Backups are listed inside each
 * asset, and assets inside each device, so everything hangs off the device
 * list:
 *
 *   GET bcdr/device                      every appliance, paged
 *   GET bcdr/device/{serial}/asset       that appliance's agents and shares,
 *                                        each with its recent backups
 *
 * One connector instance serves one sync. It remembers what it has fetched,
 * so `listClients`, `listAssets` and `listResults` between them request each
 * device's assets exactly once.
 *
 * Datto's field names and status strings are unverified; see schema.ts for
 * the list of what to check against a live account.
 */
export class DattoConnector implements Connector {
  readonly vendor = "datto_bcdr" as const;
  readonly #http: HttpClient;
  readonly #logger: Logger | undefined;
  #devices: Promise<DattoDevice[]> | undefined;
  readonly #assets = new Map<string, Promise<DattoAsset[]>>();

  constructor(credentials: DattoCredentials, options: DattoClientOptions = {}) {
    this.#http = createDattoClient(credentials, options);
    this.#logger = options.logger;
  }

  /**
   * Asks for a single device. Cheap, and it exercises exactly what a sync
   * needs: valid keys with permission to read BCDR devices.
   */
  async testConnection(): Promise<void> {
    await this.#http.getJson("bcdr/device", { _page: 1, _perPage: 1 });
  }

  async listClients(): Promise<VendorClient[]> {
    const clients = new Map<string, VendorClient>();
    for (const device of await this.#listDevices()) {
      const client = clientOf(device);
      if (!clients.has(client.vendorClientId)) clients.set(client.vendorClientId, client);
    }
    return [...clients.values()].sort((a, b) => a.name.localeCompare(b.name, "en"));
  }

  async listAssets(clientId: string): Promise<VendorAsset[]> {
    const devices = (await this.#listDevices()).filter(
      (device) => clientOf(device).vendorClientId === clientId,
    );
    const perDevice = await Promise.all(devices.map((device) => this.#deviceAssets(device)));
    return perDevice.flatMap(({ device, assets }) =>
      assets.map((asset): VendorAsset => ({
        vendorAssetId: assetIdOf(device, asset),
        vendorClientId: clientId,
        name: asset.name,
        type: assetTypeOf(asset),
        deviceName: device.name?.trim() || device.serialNumber,
        isPaused: asset.isPaused === true,
        isArchived: asset.isArchived === true,
        // Datto's API is not known to expose the backup schedule.
        expectedFrequencyHours: null,
      })),
    );
  }

  async listResults(since: Date): Promise<VendorResult[]> {
    const devices = await this.#listDevices();
    const perDevice = await Promise.all(devices.map((device) => this.#deviceAssets(device)));

    // Keyed by asset and time, so a backup the vendor lists twice is stored once.
    const results = new Map<string, VendorResult>();
    let unreadable = 0;

    for (const { device, assets } of perDevice) {
      for (const asset of assets) {
        const vendorAssetId = assetIdOf(device, asset);
        for (const raw of asset.backups ?? []) {
          const parsed = dattoBackupSchema.safeParse(raw);
          const at = parsed.success ? parseDattoTimestamp(parsed.data.timestamp) : null;
          if (!parsed.success || !at) {
            unreadable += 1;
            continue;
          }
          if (at.getTime() < since.getTime()) continue;

          const screenshot = screenshotOutcome(parsed.data);
          const vendorResultId = String(at.getTime());
          results.set(`${vendorAssetId}|${vendorResultId}`, {
            vendorResultId,
            vendorAssetId,
            startedAt: at,
            // Datto reports the moment of the snapshot, not a duration.
            endedAt: at,
            vendorStatusRaw: parsed.data.backup?.status?.trim() || "(none)",
            message: dattoMessage(parsed.data),
            screenshotVerified: screenshot === "not_attempted" ? null : screenshot === "passed",
            // Exactly what Datto sent for this backup, unparsed.
            rawPayload: raw,
          });
        }
      }
    }

    if (unreadable > 0) {
      this.#logger?.warn({ unreadable }, "skipped Datto backup entries that could not be read");
    }
    return [...results.values()].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  }

  normalizeStatus(raw: unknown): NormalizedStatus {
    return normalizeDattoStatus(raw);
  }

  /** Every device on the account, fetched once per connector. */
  #listDevices(): Promise<DattoDevice[]> {
    this.#devices ??= (async () => {
      const raw = await collectPages((page) =>
        this.#page("bcdr/device", { _page: page, _perPage: PAGE_SIZE }),
      );
      const devices: DattoDevice[] = [];
      let skipped = 0;
      for (const item of raw) {
        const parsed = dattoDeviceSchema.safeParse(item);
        if (parsed.success && SAFE_SERIAL.test(parsed.data.serialNumber)) devices.push(parsed.data);
        else skipped += 1;
      }
      if (skipped > 0) {
        this.#logger?.warn({ skipped }, "skipped Datto devices that could not be read");
      }
      return devices;
    })();
    return this.#devices;
  }

  /** One device's assets, fetched once per connector. */
  async #deviceAssets(device: DattoDevice): Promise<DeviceAssets> {
    const serial = device.serialNumber;
    let pending = this.#assets.get(serial);
    if (!pending) {
      pending = this.#fetchAssets(serial);
      this.#assets.set(serial, pending);
    }
    return { device, assets: await pending };
  }

  async #fetchAssets(serial: string): Promise<DattoAsset[]> {
    let raw: unknown[];
    try {
      raw = await collectPages((page) =>
        this.#page(`bcdr/device/${serial}/asset`, { _page: page, _perPage: PAGE_SIZE }),
      );
    } catch (error) {
      // A device removed between listing and fetching is simply gone. Every
      // other failure must fail the sync: carrying on would leave this
      // device's assets without fresh results while the sync reports success,
      // and they would then be flagged as missed.
      if (error instanceof VendorError && error.status === 404) {
        this.#logger?.warn("a Datto device disappeared during the sync; skipping it");
        return [];
      }
      throw error;
    }

    const assets: DattoAsset[] = [];
    let skipped = 0;
    for (const item of raw) {
      const parsed = dattoAssetSchema.safeParse(item);
      if (parsed.success) assets.push(parsed.data);
      else skipped += 1;
    }
    if (skipped > 0) this.#logger?.warn({ skipped }, "skipped Datto assets that could not be read");
    return assets;
  }

  /**
   * One page of a list. Accepts both shapes Datto might use: the documented
   * `{ pagination, items }` wrapper, or a bare array (treated as the only page).
   */
  async #page(path: string, query: { _page: number; _perPage: number }): Promise<Page<unknown>> {
    const body = await this.#http.getJson(path, query);
    if (Array.isArray(body)) return { items: body, totalPages: 1 };
    const parsed = dattoPageSchema.safeParse(body);
    if (!parsed.success) throw new InvalidResponseError("list is neither an array nor a page");
    return { items: parsed.data.items, totalPages: parsed.data.pagination?.totalPages ?? null };
  }
}

/**
 * Which of the MSP's customers a device belongs to.
 *
 * UNVERIFIED: this prefers `clientCompanyName`, then the organization, and
 * finally treats an unassigned device as a client of its own so nothing is
 * dropped. If real data shows the organization is the right field, or that
 * `organizationName` is the MSP itself, change it here.
 *
 * Names are compared case-insensitively, so "Acme" and "ACME" on two devices
 * are one client.
 */
export function clientOf(device: DattoDevice): VendorClient {
  const company = device.clientCompanyName?.trim();
  if (company) return { vendorClientId: `company:${company.toLowerCase()}`, name: company };

  const organizationName = device.organizationName?.trim();
  const organizationId = device.organizationId;
  if (organizationId !== null && organizationId !== undefined && String(organizationId) !== "") {
    return {
      vendorClientId: `org:${organizationId}`,
      name: organizationName || `Organization ${organizationId}`,
    };
  }
  if (organizationName) {
    return { vendorClientId: `org-name:${organizationName.toLowerCase()}`, name: organizationName };
  }
  return {
    vendorClientId: `device:${device.serialNumber}`,
    name: device.name?.trim() || device.serialNumber,
  };
}

/** Stable id for an asset within the account: its device plus its key on that device. */
function assetIdOf(device: DattoDevice, asset: DattoAsset): string {
  return `${device.serialNumber}:${asset.volume?.trim() || asset.name}`;
}

/** Datto's own type when it gives one; otherwise agents are the ones with an OS or agent version. */
function assetTypeOf(asset: DattoAsset): string {
  const declared = asset.type?.trim().toLowerCase();
  if (declared) return declared;
  return asset.agentVersion || asset.os ? "agent" : "share";
}
