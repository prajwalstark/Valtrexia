import { z } from "zod";
import { AuthError, NetworkError, RateLimitError } from "../errors";
import type {
  Connector,
  NormalizedStatus,
  VendorAsset,
  VendorClient,
  VendorResult,
} from "../types";
import { buildCatalog, hash, type MockAsset, type MockCatalog } from "./catalog";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** The mock vendor keeps this much history, like a real one with a retention limit. */
const RETENTION_DAYS = 30;

export const mockCredentialsSchema = z.object({
  /** Same seed, same fleet. Different seeds give different-looking tenants. */
  seed: z.string().min(1).default("demo"),
  /** Makes every call fail in a particular way, to exercise error handling. */
  simulate: z.enum(["auth_error", "rate_limited", "outage"]).optional(),
});
export type MockCredentials = z.infer<typeof mockCredentialsSchema>;

/** The mock vendor's own record for one backup job. Its vocabulary, not ours. */
const mockJobSchema = z.object({
  jobId: z.string(),
  assetId: z.string(),
  state: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  detail: z.string().nullable(),
  screenshot: z.object({ attempted: z.boolean(), passed: z.boolean() }).nullable(),
});
export type MockJob = z.infer<typeof mockJobSchema>;

const FAILURE_DETAILS = [
  "Snapshot timed out waiting for the VSS writer",
  "Backup volume is out of space",
  "Agent did not respond",
  "Could not quiesce the file system",
];

/**
 * A vendor that exists only in this file. It produces a believable fleet and
 * a rolling backup history without any network access or API keys, so the
 * whole product can run, be demonstrated and be tested end to end.
 *
 * History is a pure function of (seed, asset, time slot). Asking twice gives
 * the same jobs with the same ids; asking later gives the same jobs plus the
 * new ones, and a job that was running is now finished.
 */
export class MockConnector implements Connector {
  readonly vendor = "mock" as const;
  readonly #catalog: MockCatalog;
  readonly #seed: string;
  readonly #simulate: MockCredentials["simulate"];
  readonly #now: () => Date;

  constructor(credentials: MockCredentials, options: { now?: () => Date } = {}) {
    this.#seed = credentials.seed;
    this.#simulate = credentials.simulate;
    this.#catalog = buildCatalog(credentials.seed);
    this.#now = options.now ?? (() => new Date());
  }

  #fail(): void {
    if (this.#simulate === "auth_error") throw new AuthError(401);
    if (this.#simulate === "rate_limited") throw new RateLimitError(120_000);
    if (this.#simulate === "outage") throw new NetworkError(false);
  }

  async testConnection(): Promise<void> {
    this.#fail();
  }

  async listClients(): Promise<VendorClient[]> {
    this.#fail();
    return this.#catalog.clients.map((client) => ({
      vendorClientId: client.id,
      name: client.name,
    }));
  }

  async listAssets(clientId: string): Promise<VendorAsset[]> {
    this.#fail();
    return this.#catalog.assets
      .filter((asset) => asset.clientId === clientId)
      .map((asset) => ({
        vendorAssetId: asset.id,
        vendorClientId: asset.clientId,
        name: asset.name,
        type: asset.type,
        deviceName: asset.deviceName,
        isPaused: asset.behavior.kind === "paused",
        isArchived: asset.behavior.kind === "archived",
        expectedFrequencyHours: asset.frequencyHours,
      }));
  }

  async listResults(since: Date): Promise<VendorResult[]> {
    this.#fail();
    const now = this.#now().getTime();
    const from = Math.max(since.getTime(), now - RETENTION_DAYS * DAY);

    const results: VendorResult[] = [];
    for (const asset of this.#catalog.assets) {
      const frequency = asset.frequencyHours * HOUR;
      const first = Math.ceil((from - asset.offsetMs) / frequency);
      const last = Math.floor((now - asset.offsetMs) / frequency);
      for (let slot = first; slot <= last; slot += 1) {
        const job = this.#job(asset, slot * frequency + asset.offsetMs, now);
        if (job) results.push(toVendorResult(job));
      }
    }
    return results.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  }

  /** The job that started at `startMs`, or null if the asset produced none. */
  #job(asset: MockAsset, startMs: number, nowMs: number): MockJob | null {
    const behavior = asset.behavior;
    const day = Math.floor(startMs / DAY);
    const h = hash(`${this.#seed}:${asset.id}:${startMs}`);

    if (behavior.kind === "never" || behavior.kind === "paused" || behavior.kind === "archived") {
      return null;
    }
    if (behavior.kind === "silent" && (day + behavior.phase) % 7 < 3) return null;

    const endMs = startMs + asset.durationMs + (h % 300) * 1000;
    const base = {
      jobId: `${asset.id}:${startMs}`,
      assetId: asset.id,
      startedAt: new Date(startMs).toISOString(),
    };

    if (endMs > nowMs) {
      return { ...base, state: "RUNNING", finishedAt: null, detail: null, screenshot: null };
    }
    const finishedAt = new Date(endMs).toISOString();
    // Shares have nothing to boot, so screenshot verification is never attempted.
    const verified = asset.type === "share" ? null : { attempted: true, passed: true };

    if (behavior.kind === "unrecognized") {
      return { ...base, state: "DEGRADED", finishedAt, detail: null, screenshot: null };
    }

    const failed =
      (behavior.kind === "streak" && (day + behavior.phase) % 9 < 3) ||
      (behavior.kind === "healthy" && h % 40 === 0);
    if (failed) {
      return {
        ...base,
        state: "FAILED",
        finishedAt,
        detail: FAILURE_DETAILS[h % FAILURE_DETAILS.length]!,
        screenshot: null,
      };
    }

    if (behavior.kind === "screenshot" && (day + behavior.phase) % 3 === 0) {
      return {
        ...base,
        state: "COMPLETED",
        finishedAt,
        detail: "Screenshot verification failed: the machine did not reach the login screen",
        screenshot: { attempted: true, passed: false },
      };
    }

    if (behavior.kind === "healthy" && h % 40 === 1) {
      return {
        ...base,
        state: "COMPLETED_WITH_WARNINGS",
        finishedAt,
        detail: "One volume was skipped because it is excluded by policy",
        screenshot: verified,
      };
    }

    return { ...base, state: "COMPLETED", finishedAt, detail: null, screenshot: verified };
  }

  normalizeStatus(raw: unknown): NormalizedStatus {
    return normalizeMockStatus(raw);
  }
}

function toVendorResult(job: MockJob): VendorResult {
  return {
    vendorResultId: job.jobId,
    vendorAssetId: job.assetId,
    startedAt: new Date(job.startedAt),
    endedAt: job.finishedAt ? new Date(job.finishedAt) : null,
    vendorStatusRaw: job.state,
    message: job.detail,
    screenshotVerified: job.screenshot?.attempted ? job.screenshot.passed : null,
    rawPayload: job,
  };
}

/**
 * Maps the mock vendor's job record to a normalized status.
 *
 * A completed job whose screenshot verification failed is a warning, not a
 * success: the data was captured, but nobody has shown it will boot.
 */
export function normalizeMockStatus(raw: unknown): NormalizedStatus {
  const parsed = mockJobSchema.safeParse(raw);
  if (!parsed.success) return "unknown";
  const job = parsed.data;

  switch (job.state) {
    case "RUNNING":
      return "running";
    case "FAILED":
      return "failed";
    case "COMPLETED_WITH_WARNINGS":
      return "warning";
    case "COMPLETED":
      return job.screenshot?.attempted && !job.screenshot.passed ? "warning" : "success";
    default:
      return "unknown";
  }
}
