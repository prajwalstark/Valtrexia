import type { Logger } from "@valtrexia/core/server";
import type { HttpClient } from "../http";
import type {
  Connector,
  NormalizedStatus,
  VendorAsset,
  VendorClient,
  VendorResult,
} from "../types";
import {
  collectVspcCollection,
  createVspcClient,
  selectQuery,
  type VspcClientOptions,
} from "./client";
import type { VspcCredentials } from "./credentials";
import { frequencyOfSchedule, normalizeVspcStatus, sessionMessage } from "./normalize";
import {
  parseVspcTimestamp,
  vspcAgentJobSchema,
  vspcAgentSchema,
  vspcCompanySchema,
  vspcServerJobSchema,
  vspcVmObjectSchema,
  type VspcAgent,
  type VspcAgentJob,
  type VspcCompany,
  type VspcServerJob,
  type VspcVmObject,
} from "./schema";
import type { z } from "zod";

/** Company statuses that mean the company is gone, in REST API 3.5.1 and 3.6.1 spellings. */
const GONE = new Set(["Deleting", "Deleted", "REMOVED_Deleting", "REMOVED_Deleted"]);

/** Properties requested from each collection: only what is read below. */
const FIELDS = {
  companies: ["instanceUid", "name", "status"],
  serverJobs: [
    "instanceUid",
    "uniqueUid",
    "name",
    "type",
    "organizationUid",
    "mappedOrganizationUid",
    "isEnabled",
    "scheduleType",
    "status",
  ],
  vmObjects: [
    "jobUid",
    "uniqueJobUid",
    "instanceUid",
    "name",
    "platform",
    "isExcluded",
    "lastSession",
  ],
  agents: ["instanceUid", "name", "organizationUid", "agentPlatform", "platform"],
  agentJobs: [
    "instanceUid",
    "backupAgentUid",
    "organizationUid",
    "name",
    "status",
    "lastRun",
    "lastEndTime",
    "failureMessage",
    "isEnabled",
    "scheduleType",
  ],
} as const;

interface Snapshot {
  companies: VspcCompany[];
  /** Every server job, by its UID. */
  jobs: Map<string, VspcServerJob>;
  vmObjects: VspcVmObject[];
  agents: Map<string, VspcAgent>;
  agentJobs: VspcAgentJob[];
}

/** One asset as gathered from its jobs. */
interface Gathered {
  asset: VendorAsset;
  /** Each job's `isEnabled`; the asset is paused when every one of them is off. */
  enabled: boolean[];
  frequencies: (number | null)[];
}

/**
 * Veeam Service Provider Console, read-only.
 *
 * VSPC reports the latest session of each job, not a history. So each sync
 * stores what the latest session of each job says, keyed by when it started,
 * and history builds up from the first sync onwards: a session seen on
 * successive syncs is the same result, a new session is a new one. Unlike
 * Datto, a first sync cannot reach back fourteen days.
 *
 * Two kinds of machine are watched:
 *
 *   - VMs in backup jobs on Veeam Backup & Replication servers. Each job
 *     object is one VM in one job, with that job's last session for that VM.
 *     The client is the organization the job is assigned to.
 *       GET infrastructure/backupServers/jobs
 *       GET infrastructure/backupServers/jobs/backupVmJobs/objects
 *   - Computers with a Veeam backup agent, through the agent's jobs.
 *       GET infrastructure/backupAgents
 *       GET infrastructure/backupAgents/jobs
 *
 * Not yet covered: replication, backup copy, file share, object storage,
 * cloud and Microsoft 365 jobs, and agents managed by a backup server rather
 * than by the console. Their machines are not listed, so nothing is wrongly
 * reported about them.
 *
 * One connector instance serves one sync; everything is fetched once.
 */
export class VspcConnector implements Connector {
  readonly vendor = "veeam_vspc" as const;
  readonly #http: HttpClient;
  readonly #logger: Logger | undefined;
  #snapshot: Promise<Snapshot> | undefined;

  constructor(credentials: VspcCredentials, options: VspcClientOptions = {}) {
    this.#http = createVspcClient(credentials, options);
    this.#logger = options.logger;
  }

  /** One company: proves the address, the certificate, the key and its permission to read. */
  async testConnection(): Promise<void> {
    await this.#http.getJson("organizations/companies", {
      offset: 0,
      limit: 1,
      select: selectQuery(FIELDS.companies),
    });
  }

  async listClients(): Promise<VendorClient[]> {
    const { companies } = await this.#load();
    return companies
      .filter((company) => !GONE.has(company.status ?? ""))
      .map((company) => ({ vendorClientId: company.instanceUid, name: company.name.trim() }))
      .sort((a, b) => a.name.localeCompare(b.name, "en"));
  }

  async listAssets(clientId: string): Promise<VendorAsset[]> {
    return [...((await this.#assetsByClient()).get(clientId)?.values() ?? [])].map(
      ({ asset, enabled, frequencies }) => {
        const known = frequencies.filter((f): f is number => f !== null);
        return {
          ...asset,
          isPaused: enabled.length > 0 && enabled.every((on) => !on),
          expectedFrequencyHours: known.length > 0 ? Math.min(...known) : null,
        };
      },
    );
  }

  async listResults(since: Date): Promise<VendorResult[]> {
    const snapshot = await this.#load();
    const results = new Map<string, VendorResult>();

    for (const object of snapshot.vmObjects) {
      const session = object.lastSession;
      const startedAt = parseVspcTimestamp(session?.startTime);
      if (!session || !startedAt || startedAt < since) continue;
      const running = session.backupStatus === "Running";
      const result: VendorResult = {
        vendorResultId: `${object.uniqueJobUid ?? object.jobUid}:${startedAt.toISOString()}`,
        vendorAssetId: vmAssetId(object),
        startedAt,
        endedAt: running ? null : (parseVspcTimestamp(session.endTime) ?? null),
        vendorStatusRaw: session.backupStatus ?? "Unknown",
        message: sessionMessage(session.messages),
        screenshotVerified: null,
        rawPayload: object,
      };
      results.set(`${result.vendorAssetId}|${result.vendorResultId}`, result);
    }

    for (const job of snapshot.agentJobs) {
      const startedAt = parseVspcTimestamp(job.lastRun);
      if (!startedAt || startedAt < since) continue;
      const running = ["Starting", "Running", "Stopping"].includes(job.status ?? "");
      const failed = job.status === "Failed" || job.status === "Warning";
      const result: VendorResult = {
        vendorResultId: `${job.instanceUid}:${startedAt.toISOString()}`,
        vendorAssetId: agentAssetId(job.backupAgentUid),
        startedAt,
        endedAt: running ? null : (parseVspcTimestamp(job.lastEndTime) ?? null),
        vendorStatusRaw: job.status ?? "Unknown",
        message: failed ? sessionMessage(job.failureMessage ? [job.failureMessage] : []) : null,
        screenshotVerified: null,
        rawPayload: job,
      };
      results.set(`${result.vendorAssetId}|${result.vendorResultId}`, result);
    }
    return [...results.values()];
  }

  normalizeStatus(raw: unknown): NormalizedStatus {
    return normalizeVspcStatus(raw);
  }

  #load(): Promise<Snapshot> {
    this.#snapshot ??= (async () => {
      const [companies, jobs, vmObjects, agents, agentJobs] = await Promise.all([
        this.#collect("organizations/companies", FIELDS.companies, vspcCompanySchema),
        this.#collect("infrastructure/backupServers/jobs", FIELDS.serverJobs, vspcServerJobSchema),
        this.#collect(
          "infrastructure/backupServers/jobs/backupVmJobs/objects",
          FIELDS.vmObjects,
          vspcVmObjectSchema,
        ),
        this.#collect("infrastructure/backupAgents", FIELDS.agents, vspcAgentSchema),
        this.#collect("infrastructure/backupAgents/jobs", FIELDS.agentJobs, vspcAgentJobSchema),
      ]);
      return {
        companies,
        jobs: new Map(jobs.map((job) => [job.instanceUid, job])),
        vmObjects,
        agents: new Map(agents.map((agent) => [agent.instanceUid, agent])),
        agentJobs,
      };
    })();
    return this.#snapshot;
  }

  /** A collection, keeping the items that parse. One unreadable item does not fail the sync. */
  async #collect<T>(path: string, select: readonly string[], schema: z.ZodType<T>): Promise<T[]> {
    const items = await collectVspcCollection(this.#http, path, select);
    const parsed: T[] = [];
    let unreadable = 0;
    for (const item of items) {
      const result = schema.safeParse(item);
      if (result.success) parsed.push(result.data);
      else unreadable += 1;
    }
    // Counts only: the items themselves may hold anything.
    if (unreadable > 0) this.#logger?.warn({ path, unreadable }, "skipped unreadable VSPC items");
    return parsed;
  }

  async #assetsByClient(): Promise<Map<string, Map<string, Gathered>>> {
    const snapshot = await this.#load();
    const byClient = new Map<string, Map<string, Gathered>>();
    const add = (
      clientId: string,
      asset: Omit<VendorAsset, "isPaused" | "expectedFrequencyHours">,
      enabled: boolean,
      frequency: number | null,
    ) => {
      const assets = byClient.get(clientId) ?? new Map<string, Gathered>();
      const gathered = assets.get(asset.vendorAssetId) ?? {
        asset: { ...asset, isPaused: false, isArchived: false, expectedFrequencyHours: null },
        enabled: [],
        frequencies: [],
      };
      gathered.enabled.push(enabled);
      gathered.frequencies.push(frequency);
      assets.set(asset.vendorAssetId, gathered);
      byClient.set(clientId, assets);
    };

    for (const object of snapshot.vmObjects) {
      if (object.isExcluded) continue;
      const job = snapshot.jobs.get(object.jobUid);
      // The job's client: the organization it is assigned to, or else the one
      // that owns its backup server. A job of the provider's own is no client's.
      const clientId = job?.mappedOrganizationUid ?? job?.organizationUid;
      if (!job || !clientId) continue;
      add(
        clientId,
        {
          vendorAssetId: vmAssetId(object),
          vendorClientId: clientId,
          name: object.name.trim(),
          type: "vm",
          deviceName: job.name?.trim() || null,
          isArchived: false,
        },
        job.isEnabled !== false,
        frequencyOfSchedule(job.scheduleType),
      );
    }

    for (const job of snapshot.agentJobs) {
      const agent = snapshot.agents.get(job.backupAgentUid);
      const clientId = job.organizationUid ?? agent?.organizationUid;
      if (!clientId) continue;
      add(
        clientId,
        {
          vendorAssetId: agentAssetId(job.backupAgentUid),
          vendorClientId: clientId,
          name: (agent?.name ?? job.name ?? job.backupAgentUid).trim(),
          type: "agent",
          deviceName: null,
          isArchived: false,
        },
        job.isEnabled !== false,
        frequencyOfSchedule(job.scheduleType),
      );
    }
    return byClient;
  }
}

function vmAssetId(object: VspcVmObject): string {
  return `vm:${object.instanceUid}`;
}

function agentAssetId(backupAgentUid: string): string {
  return `agent:${backupAgentUid}`;
}
