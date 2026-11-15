import { summarizeClientHealth, type BackupStatus, type HealthAsset } from "@valtrexia/core";
import { describe, expect, it } from "vitest";
import type { IntegrationProblem } from "./dashboard-core";
import {
  describeClient,
  describeIntegrationProblem,
  describeSync,
  type SyncFacts,
} from "./describe";
import { count, elapsed, formatDateTime, formatDayKey } from "./format";

const NOW = new Date("2026-11-12T12:00:00Z");
const asset = (currentStatus: BackupStatus, extra: Partial<HealthAsset> = {}): HealthAsset => ({
  currentStatus,
  mutedUntil: null,
  isPaused: false,
  isArchived: false,
  ...extra,
});
const say = (assets: HealthAsset[], syncFailing = false) =>
  describeClient(summarizeClientHealth(assets, { now: NOW, syncFailing }));

describe("describeClient", () => {
  it("names what has failed or been missed, and out of how many", () => {
    expect(
      say([asset("failed"), asset("failed"), asset("missed"), asset("success"), asset("warning")]),
    ).toBe("2 failed, 1 missed of 5 assets");
    expect(say([asset("missed")])).toBe("1 missed of 1 asset");
  });

  it("names warnings and unreadable statuses when nothing is worse", () => {
    expect(say([asset("warning"), asset("unknown"), asset("success")])).toBe(
      "1 with warnings, 1 unknown of 3 assets",
    );
  });

  it("says the vendor data is out of date when that is the only problem", () => {
    expect(say([asset("success"), asset("success")], true)).toBe(
      "Vendor data out of date; 2 assets not confirmed",
    );
  });

  it("confirms a healthy client, mentioning backups in progress", () => {
    expect(say([asset("success"), asset("success"), asset("success")])).toBe(
      "All 3 assets backed up",
    );
    expect(say([asset("success")])).toBe("Its 1 asset is backed up");
    expect(say([asset("success"), asset("success"), asset("running")])).toBe(
      "2 backed up, 1 running",
    );
  });

  it("explains a client with nothing to watch", () => {
    expect(say([])).toBe("No protected assets found yet");
    expect(say([asset("failed", { isArchived: true }), asset("success", { isPaused: true })])).toBe(
      "2 assets, none being watched",
    );
  });
});

const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

describe("describeSync", () => {
  const facts = (overrides: Partial<SyncFacts> = {}): SyncFacts => ({
    syncStatus: "ok",
    lastSyncAt: minutesAgo(5),
    lastSyncError: null,
    lastSyncErrorKind: null,
    consecutiveFailures: 0,
    failingSince: null,
    createdAt: minutesAgo(60 * 24 * 30),
    ...overrides,
  });
  const say = (overrides: Partial<SyncFacts> = {}) => describeSync(facts(overrides), NOW, 15);

  it("reports a healthy integration by when it last synced", () => {
    expect(say()).toEqual({ state: "healthy", syncing: false, text: "Last synced 5 minutes ago" });
    expect(say({ syncStatus: "running" })).toEqual({
      state: "healthy",
      syncing: true,
      text: "Syncing now. Last synced 5 minutes ago.",
    });
  });

  it("says a new integration is waiting", () => {
    const fresh = { syncStatus: "never", lastSyncAt: null, createdAt: minutesAgo(1) } as const;
    expect(say(fresh).text).toBe("Waiting for its first sync");
  });

  it("says a first failure will be retried, with the reason", () => {
    expect(
      say({
        syncStatus: "error",
        consecutiveFailures: 1,
        failingSince: minutesAgo(10),
        lastSyncErrorKind: "network",
        lastSyncError: "The vendor API could not be reached.",
        lastSyncAt: minutesAgo(25),
      }),
    ).toEqual({
      state: "retrying",
      syncing: false,
      text: "The last sync failed and will be retried. The vendor API could not be reached. Last synced 25 minutes ago.",
    });
  });

  it("says how long a run of failures has lasted and how many attempts it has had", () => {
    expect(
      say({
        syncStatus: "error",
        consecutiveFailures: 6,
        failingSince: minutesAgo(90),
        lastSyncErrorKind: "vendor",
        lastSyncError: "The vendor API returned an error (HTTP 503).",
        lastSyncAt: minutesAgo(105),
      }).text,
    ).toBe(
      "Sync failing since 12 Nov, 10:30 UTC (6 attempts). The vendor API returned an error (HTTP 503). Last synced 1 hour ago.",
    );
  });

  it("says a rejected key will not fix itself", () => {
    const description = say({
      syncStatus: "error",
      consecutiveFailures: 1,
      failingSince: minutesAgo(10),
      lastSyncErrorKind: "auth",
      lastSyncError: "The vendor rejected these credentials. Check the keys and their permissions.",
    });
    expect(description.state).toBe("unhealthy");
    expect(description.text).toContain("It will keep failing until the keys are replaced.");
  });

  it("says when syncs have simply stopped", () => {
    expect(say({ lastSyncAt: minutesAgo(180) })).toEqual({
      state: "stalled",
      syncing: false,
      text: "No sync has finished since 12 Nov, 09:00 UTC. Syncs should run every 15 minutes; the background worker may not be running.",
    });
    expect(say({ syncStatus: "never", lastSyncAt: null, createdAt: minutesAgo(180) }).text).toBe(
      "Connected 3 hours ago and not synced yet. The background worker may not be running.",
    );
  });
});

describe("describeIntegrationProblem", () => {
  const problem = (overrides: Partial<IntegrationProblem>): IntegrationProblem => ({
    id: "i1",
    name: "Datto main",
    vendor: "datto_bcdr",
    state: "unhealthy",
    since: minutesAgo(180),
    needsAction: false,
    error: "The vendor API could not be reached.",
    lastSyncAt: minutesAgo(195),
    unconfirmedAssets: 0,
    ...overrides,
  });

  it("says how long it has been failing, why, and how many assets that leaves unconfirmed", () => {
    expect(describeIntegrationProblem(problem({ unconfirmedAssets: 12 }), NOW)).toEqual({
      text: "Datto main has been failing to sync for 3 hours. The vendor API could not be reached. 12 assets can no longer be confirmed.",
      action: "View integration",
    });
  });

  it("points at the keys when they are the problem", () => {
    const rejected = problem({
      needsAction: true,
      error: "The vendor rejected these credentials.",
    });
    expect(describeIntegrationProblem(rejected, NOW).action).toBe("Replace the keys");
  });

  it("is brief about a failure that is still being retried", () => {
    expect(describeIntegrationProblem(problem({ state: "retrying" }), NOW).text).toBe(
      "Datto main: the last sync failed and will be retried.",
    );
  });

  it("says since when a stalled integration has had no data", () => {
    const stalled = problem({ state: "stalled", error: null, unconfirmedAssets: 1 });
    expect(describeIntegrationProblem(stalled, NOW).text).toBe(
      "Datto main has not synced since 12 Nov, 08:45 UTC. 1 asset can no longer be confirmed.",
    );
    expect(
      describeIntegrationProblem(problem({ state: "stalled", lastSyncAt: null }), NOW).text,
    ).toBe("Datto main has not synced yet.");
  });
});

describe("formatting", () => {
  it("gives a length of time in the largest whole unit", () => {
    expect(elapsed(minutesAgo(0.5), NOW)).toBe("a moment");
    expect(elapsed(minutesAgo(1), NOW)).toBe("1 minute");
    expect(elapsed(minutesAgo(59), NOW)).toBe("59 minutes");
    expect(elapsed(minutesAgo(60), NOW)).toBe("1 hour");
    expect(elapsed(minutesAgo(60 * 47), NOW)).toBe("1 day");
    expect(elapsed(minutesAgo(60 * 24 * 20), NOW)).toBe("20 days");
  });

  it("formats a date and time in UTC on a 24-hour clock", () => {
    expect(formatDateTime(new Date("2026-11-12T13:05:00Z"))).toBe("12 Nov, 13:05 UTC");
    expect(formatDateTime(new Date("2026-01-01T00:00:00Z"))).toBe("1 Jan, 00:00 UTC");
    expect(formatDateTime(new Date("2026-11-12T23:59:00-05:00"))).toBe("13 Nov, 04:59 UTC");
  });

  it("formats a day key", () => {
    expect(formatDayKey("2026-11-02")).toBe("2 Nov");
  });

  it("pluralizes", () => {
    expect(count(0, "asset")).toBe("0 assets");
    expect(count(1, "asset")).toBe("1 asset");
    expect(count(2, "asset")).toBe("2 assets");
    expect(count(2, "entry", "entries")).toBe("2 entries");
  });
});
