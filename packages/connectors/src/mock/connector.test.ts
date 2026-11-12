import { isCompletedBackup, lastCompletedBackupAt } from "@valtrexia/core";
import { Secret } from "@valtrexia/core/server";
import { describe, expect, it } from "vitest";
import {
  AuthError,
  ConnectorUnavailableError,
  InvalidCredentialsShapeError,
  NetworkError,
  RateLimitError,
} from "../errors";
import { createConnector, isMockAllowed } from "../registry";
import type { VendorAsset, VendorResult } from "../types";
import { MockConnector, normalizeMockStatus } from "./connector";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-11-12T12:00:00Z");
const daysBefore = (date: Date, days: number) => new Date(date.getTime() - days * DAY);

const connectorAt = (now: Date, seed = "demo") => new MockConnector({ seed }, { now: () => now });

async function fleet(connector: MockConnector) {
  const clients = await connector.listClients();
  const assets = (
    await Promise.all(clients.map((c) => connector.listAssets(c.vendorClientId)))
  ).flat();
  return { clients, assets };
}

/** What the dashboard would conclude about each asset at `now`. */
async function snapshot(now: Date, seed = "demo") {
  const connector = connectorAt(now, seed);
  const { assets } = await fleet(connector);
  const results = await connector.listResults(daysBefore(now, 14));
  const byAsset = new Map<string, VendorResult[]>();
  for (const result of results) {
    byAsset.set(result.vendorAssetId, [...(byAsset.get(result.vendorAssetId) ?? []), result]);
  }
  return assets.map((asset: VendorAsset) => {
    const own = byAsset.get(asset.vendorAssetId) ?? [];
    const latest = own.at(-1);
    const completed = lastCompletedBackupAt(
      own.map((r) => ({
        status: connector.normalizeStatus(r.rawPayload),
        startedAt: r.startedAt,
        endedAt: r.endedAt,
      })),
    );
    return {
      asset,
      count: own.length,
      latestStatus: latest ? connector.normalizeStatus(latest.rawPayload) : null,
      hoursSinceCompleted: completed ? (now.getTime() - completed.getTime()) / HOUR : null,
    };
  });
}

describe("mock connector: the fleet", () => {
  it("has 12 clients and a realistic number of assets", async () => {
    const { clients, assets } = await fleet(connectorAt(NOW));
    expect(clients).toHaveLength(12);
    expect(new Set(clients.map((c) => c.vendorClientId)).size).toBe(12);
    expect(assets.length).toBeGreaterThanOrEqual(36);
    expect(assets.length).toBeLessThanOrEqual(96);
    expect(new Set(assets.map((a) => a.vendorAssetId)).size).toBe(assets.length);
  });

  it("gives every client between 3 and 8 assets, each pointing back at it", async () => {
    const connector = connectorAt(NOW);
    for (const client of await connector.listClients()) {
      const assets = await connector.listAssets(client.vendorClientId);
      expect(assets.length).toBeGreaterThanOrEqual(3);
      expect(assets.length).toBeLessThanOrEqual(8);
      for (const asset of assets) expect(asset.vendorClientId).toBe(client.vendorClientId);
    }
  });

  it("returns no assets for a client it does not know", async () => {
    expect(await connectorAt(NOW).listAssets("no-such-client")).toEqual([]);
  });

  it("is deterministic for a seed and different across seeds", async () => {
    const one = await fleet(connectorAt(NOW, "alpha"));
    const again = await fleet(connectorAt(NOW, "alpha"));
    const other = await fleet(connectorAt(NOW, "bravo"));
    expect(again).toEqual(one);
    expect(other.assets.map((a) => a.vendorAssetId)).not.toEqual(
      one.assets.map((a) => a.vendorAssetId),
    );
  });

  it("includes exactly one paused and one archived asset", async () => {
    const { assets } = await fleet(connectorAt(NOW));
    expect(assets.filter((a) => a.isPaused)).toHaveLength(1);
    expect(assets.filter((a) => a.isArchived)).toHaveLength(1);
  });

  it("reports each asset's backup frequency", async () => {
    const { assets } = await fleet(connectorAt(NOW));
    for (const asset of assets) expect([6, 12, 24]).toContain(asset.expectedFrequencyHours);
  });
});

describe("mock connector: results", () => {
  it("returns only results that started at or after `since`, oldest first", async () => {
    const connector = connectorAt(NOW);
    const since = daysBefore(NOW, 3);
    const results = await connector.listResults(since);
    expect(results.length).toBeGreaterThan(50);
    for (const result of results) {
      expect(result.startedAt.getTime()).toBeGreaterThanOrEqual(since.getTime());
      expect(result.startedAt.getTime()).toBeLessThanOrEqual(NOW.getTime());
    }
    const starts = results.map((r) => r.startedAt.getTime());
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it("gives every result a unique id, its raw payload and a known asset", async () => {
    const connector = connectorAt(NOW);
    const { assets } = await fleet(connector);
    const known = new Set(assets.map((a) => a.vendorAssetId));
    const results = await connector.listResults(daysBefore(NOW, 14));
    expect(new Set(results.map((r) => r.vendorResultId)).size).toBe(results.length);
    for (const result of results) {
      expect(known.has(result.vendorAssetId)).toBe(true);
      expect(result.rawPayload).toMatchObject({ jobId: result.vendorResultId });
      expect(result.vendorStatusRaw).toBe((result.rawPayload as { state: string }).state);
    }
  });

  it("returns the same history when asked again", async () => {
    const since = daysBefore(NOW, 14);
    expect(await connectorAt(NOW).listResults(since)).toEqual(
      await connectorAt(NOW).listResults(since),
    );
  });

  it("history never rewrites itself: a later fetch agrees with an earlier one", async () => {
    const earlier = await connectorAt(NOW).listResults(daysBefore(NOW, 14));
    const later = new Date(NOW.getTime() + 2 * DAY);
    const again = new Map(
      (await connectorAt(later).listResults(daysBefore(NOW, 14))).map((r) => [r.vendorResultId, r]),
    );
    for (const result of earlier) {
      const now = again.get(result.vendorResultId);
      expect(now, result.vendorResultId).toBeDefined();
      // Anything that had finished is unchanged. Anything that was running has now finished.
      if (result.endedAt) expect(now).toEqual(result);
      else expect(now!.endedAt).not.toBeNull();
    }
    expect(again.size).toBeGreaterThan(earlier.length);
  });

  it("a running job keeps its id when it finishes", async () => {
    const running = (await connectorAt(NOW).listResults(daysBefore(NOW, 2))).filter(
      (r) => r.endedAt === null,
    );
    expect(running.length).toBeGreaterThan(0);
    const later = await connectorAt(new Date(NOW.getTime() + DAY)).listResults(daysBefore(NOW, 2));
    for (const job of running) {
      const finished = later.find((r) => r.vendorResultId === job.vendorResultId);
      expect(finished?.endedAt).not.toBeNull();
      expect(finished?.vendorStatusRaw).not.toBe("RUNNING");
    }
  });

  it("keeps no more than 30 days of history", async () => {
    const results = await connectorAt(NOW).listResults(new Date(0));
    const oldest = results[0]!.startedAt.getTime();
    expect(oldest).toBeGreaterThanOrEqual(NOW.getTime() - 30 * DAY);
  });

  it("only attempts screenshot verification on things that can boot", async () => {
    const connector = connectorAt(NOW);
    const { assets } = await fleet(connector);
    const type = new Map(assets.map((a) => [a.vendorAssetId, a.type]));
    for (const result of await connector.listResults(daysBefore(NOW, 14))) {
      if (type.get(result.vendorAssetId) === "share") expect(result.screenshotVerified).toBeNull();
    }
  });
});

describe("mock connector: scenarios are always on show", () => {
  // Checked at several moments, including awkward ones just after midnight
  // and on different weekdays, because the scenarios follow the calendar.
  const moments = [
    "2026-11-12T12:00:00Z",
    "2026-11-13T00:05:00Z",
    "2026-11-14T01:59:00Z",
    "2026-11-15T02:30:00Z",
    "2026-11-16T23:55:00Z",
    "2026-11-18T08:00:00Z",
    "2026-11-21T16:40:00Z",
    "2027-02-03T05:15:00Z",
    "2027-06-30T19:00:00Z",
  ];

  it.each(moments)(
    "at %s there is something failing, missed, warning, running and unknown",
    async (iso) => {
      const now = new Date(iso);
      const state = await snapshot(now);
      const watched = state.filter((s) => !s.asset.isPaused && !s.asset.isArchived);

      expect(
        watched.some((s) => s.latestStatus === "failed"),
        "a failed asset",
      ).toBe(true);
      expect(
        watched.some((s) => s.latestStatus === "warning"),
        "a warning asset",
      ).toBe(true);
      expect(
        watched.some((s) => s.latestStatus === "unknown"),
        "an unknown asset",
      ).toBe(true);
      expect(
        watched.some((s) => s.latestStatus === "running"),
        "a running backup",
      ).toBe(true);

      // Missed: has history, but nothing completed within frequency + 2 h grace.
      const missed = watched.filter(
        (s) =>
          s.count > 0 &&
          s.hoursSinceCompleted !== null &&
          s.hoursSinceCompleted > (s.asset.expectedFrequencyHours ?? 24) + 2,
      );
      expect(missed.length, "an asset that has missed a backup").toBeGreaterThan(0);

      // And most of the fleet is healthy, as in a real one.
      const healthy = watched.filter((s) => s.latestStatus === "success").length;
      expect(healthy / watched.length).toBeGreaterThan(0.6);
    },
  );

  it("has one asset that has never been backed up", async () => {
    const state = await snapshot(NOW);
    const never = state.filter((s) => s.count === 0 && !s.asset.isPaused && !s.asset.isArchived);
    expect(never).toHaveLength(1);
  });

  it("paused and archived assets produce no results", async () => {
    const state = await snapshot(NOW);
    for (const s of state.filter((x) => x.asset.isPaused || x.asset.isArchived)) {
      expect(s.count).toBe(0);
    }
  });

  it("spreads the trouble across several clients", async () => {
    const state = await snapshot(NOW);
    const troubled = state.filter((s) => s.latestStatus !== "success" || s.count === 0);
    expect(new Set(troubled.map((s) => s.asset.vendorClientId)).size).toBeGreaterThanOrEqual(4);
  });
});

describe("mock connector: status normalization", () => {
  const job = (
    state: string,
    screenshot: { attempted: boolean; passed: boolean } | null = null,
  ) => ({
    jobId: "j1",
    assetId: "a1",
    state,
    startedAt: "2026-11-12T01:00:00.000Z",
    finishedAt: state === "RUNNING" ? null : "2026-11-12T01:30:00.000Z",
    detail: null,
    screenshot,
  });

  it.each([
    ["COMPLETED", null, "success"],
    ["COMPLETED", { attempted: true, passed: true }, "success"],
    ["COMPLETED", { attempted: false, passed: false }, "success"],
    ["COMPLETED", { attempted: true, passed: false }, "warning"],
    ["COMPLETED_WITH_WARNINGS", { attempted: true, passed: true }, "warning"],
    ["FAILED", null, "failed"],
    ["RUNNING", null, "running"],
    ["DEGRADED", null, "unknown"],
    ["completed", null, "unknown"],
    ["", null, "unknown"],
  ] as const)("%s with screenshot %o is %s", (state, screenshot, expected) => {
    expect(normalizeMockStatus(job(state, screenshot))).toBe(expected);
  });

  it.each([null, undefined, 42, "COMPLETED", [], {}, { state: "COMPLETED" }])(
    "returns unknown, without throwing, for malformed input %o",
    (raw) => {
      expect(normalizeMockStatus(raw)).toBe("unknown");
    },
  );

  it("never produces missed: that status is derived, not reported", async () => {
    const connector = connectorAt(NOW);
    const statuses = new Set(
      (await connector.listResults(daysBefore(NOW, 14))).map((r) =>
        connector.normalizeStatus(r.rawPayload),
      ),
    );
    expect(statuses.has("missed")).toBe(false);
    expect([...statuses].some(isCompletedBackup)).toBe(true);
  });
});

describe("mock connector: simulated failures", () => {
  it.each([
    ["auth_error", AuthError],
    ["rate_limited", RateLimitError],
    ["outage", NetworkError],
  ] as const)("simulate=%s fails every call", async (simulate, ErrorType) => {
    const connector = new MockConnector({ seed: "demo", simulate });
    await expect(connector.testConnection()).rejects.toBeInstanceOf(ErrorType);
    await expect(connector.listClients()).rejects.toBeInstanceOf(ErrorType);
    await expect(connector.listAssets("mc-01")).rejects.toBeInstanceOf(ErrorType);
    await expect(connector.listResults(NOW)).rejects.toBeInstanceOf(ErrorType);
  });

  it("passes the connection test otherwise", async () => {
    await expect(connectorAt(NOW).testConnection()).resolves.toBeUndefined();
  });
});

describe("connector registry", () => {
  const creds = (value: unknown) => new Secret(value);

  it("builds the mock connector when demo data is allowed", () => {
    const connector = createConnector("mock", creds({ seed: "demo" }), { allowMock: true });
    expect(connector).toBeInstanceOf(MockConnector);
    expect(connector.vendor).toBe("mock");
  });

  it("refuses the mock connector when demo data is not allowed", () => {
    expect(() => createConnector("mock", creds({ seed: "demo" }), { allowMock: false })).toThrow(
      ConnectorUnavailableError,
    );
  });

  it("rejects credentials of the wrong shape without echoing them", () => {
    try {
      createConnector("mock", creds({ seed: 42, extra: "fixture-secret" }), { allowMock: true });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidCredentialsShapeError);
      expect(String(error)).not.toContain("fixture-secret");
    }
  });

  it.each(["datto_bcdr", "kaseya_uniview", "veeam_vspc"] as const)(
    "reports %s as not available yet",
    (vendor) => {
      expect(() => createConnector(vendor, creds({}), { allowMock: true })).toThrow(
        ConnectorUnavailableError,
      );
    },
  );

  it("allows demo data only when switched on and never in production", () => {
    expect(isMockAllowed({ VALTREXIA_ENABLE_MOCK: "true", NODE_ENV: "development" })).toBe(true);
    expect(isMockAllowed({ VALTREXIA_ENABLE_MOCK: "true" })).toBe(true);
    expect(isMockAllowed({ VALTREXIA_ENABLE_MOCK: "true", NODE_ENV: "production" })).toBe(false);
    expect(isMockAllowed({ VALTREXIA_ENABLE_MOCK: "false", NODE_ENV: "development" })).toBe(false);
    expect(isMockAllowed({ VALTREXIA_ENABLE_MOCK: "1" })).toBe(false);
    expect(isMockAllowed({})).toBe(false);
  });
});
