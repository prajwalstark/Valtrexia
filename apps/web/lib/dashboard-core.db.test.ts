import { randomUUID } from "node:crypto";
import type { BackupStatus } from "@valtrexia/core";
import { createDb, type Db } from "@valtrexia/db";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  acknowledgeIncident,
  buildDayStrip,
  getClientDetail,
  getFleetOverview,
  HISTORY_DAYS,
  RESULTS_PER_ASSET,
} from "./dashboard-core";
import type { TenantSession } from "./session-core";

const urls = inject("databaseUrls");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Mid-afternoon UTC, so "today" has room before and after.
const NOW = new Date("2026-11-12T15:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

let db: Db;
beforeAll(() => {
  db = createDb({ url: urls.app });
});
afterAll(async () => {
  await db.disconnect();
});

interface AssetSpec {
  name: string;
  status: BackupStatus;
  paused?: boolean;
  archived?: boolean;
  mutedUntil?: Date;
  /** Hours since its last completed backup. Unset: it has never completed one. */
  lastBackupHoursAgo?: number;
  /** Hours since it was first seen. Unset: seen just now. */
  firstSeenHoursAgo?: number;
  frequencyHours?: number;
  /** [hours ago, status] for each result to store. */
  results?: [number, BackupStatus][];
  /** Open incident types to create for it. */
  incidents?: ("failed" | "missed")[];
}

/** A tenant with one integration and whatever clients and assets the test describes. */
async function tenant(
  clients: Record<string, AssetSpec[]>,
  options: {
    syncStatus?: "ok" | "error" | "never" | "running";
    role?: TenantSession["role"];
    /** Hours since the integration last synced successfully. Default: five minutes. */
    lastSyncHoursAgo?: number;
    failures?: {
      count: number;
      sinceHoursAgo: number;
      kind: "auth" | "network" | "vendor";
      message: string;
    };
    graceHours?: number;
  } = {},
) {
  const tenantId = await db.provisionTenant({ clerkOrgId: `org_${randomUUID()}`, name: "MSP" });
  return db.withTenant(tenantId, async ({ tx }) => {
    const user = await tx.user.create({
      data: {
        tenantId,
        clerkUserId: `user_${randomUUID()}`,
        email: "tech@msp.example",
        name: "Alex Tech",
        role: options.role ?? "technician",
      },
    });
    const integration = await tx.integration.create({
      data: {
        tenantId,
        vendor: "mock",
        name: "Demo data",
        credentialsEnc: { v: 1, ciphertext: "fixture-ciphertext-must-not-leak" },
        syncStatus: options.syncStatus ?? "ok",
        lastSyncAt:
          options.syncStatus === "never"
            ? null
            : ago(options.lastSyncHoursAgo ? options.lastSyncHoursAgo * HOUR : 5 * 60_000),
        // Relative to the test's clock, not today's real date. One that has
        // never synced was connected two minutes ago.
        createdAt: options.syncStatus === "never" ? ago(2 * 60_000) : ago(30 * DAY),
        ...(options.failures
          ? {
              consecutiveFailures: options.failures.count,
              failingSince: ago(options.failures.sinceHoursAgo * HOUR),
              lastSyncErrorKind: options.failures.kind,
              lastSyncError: options.failures.message,
            }
          : {}),
      },
    });
    if (options.graceHours !== undefined) {
      await tx.tenant.update({ where: { id: tenantId }, data: { graceHours: options.graceHours } });
    }
    const ids: Record<string, string> = {};
    const assetIds: Record<string, string> = {};
    const incidentIds: Record<string, string> = {};
    for (const [clientName, specs] of Object.entries(clients)) {
      const client = await tx.client.create({ data: { tenantId, name: clientName } });
      ids[clientName] = client.id;
      for (const spec of specs) {
        const asset = await tx.asset.create({
          data: {
            tenantId,
            clientId: client.id,
            integrationId: integration.id,
            vendorAssetId: `${clientName}/${spec.name}`,
            name: spec.name,
            type: "agent",
            deviceName: "BDR01",
            currentStatus: spec.status,
            isPaused: spec.paused ?? false,
            isArchived: spec.archived ?? false,
            mutedUntil: spec.mutedUntil ?? null,
            firstSeenAt: ago((spec.firstSeenHoursAgo ?? 0) * HOUR),
            lastSuccessAt:
              spec.lastBackupHoursAgo === undefined ? null : ago(spec.lastBackupHoursAgo * HOUR),
            ...(spec.frequencyHours ? { expectedFrequencyHours: spec.frequencyHours } : {}),
          },
        });
        assetIds[spec.name] = asset.id;
        for (const [hours, status] of spec.results ?? []) {
          await tx.backupResult.create({
            data: {
              tenantId,
              assetId: asset.id,
              integrationId: integration.id,
              vendorResultId: `${hours}`,
              startedAt: ago(hours * HOUR),
              endedAt: status === "running" ? null : ago(hours * HOUR - 600_000),
              status,
              vendorStatusRaw: status.toUpperCase(),
              message: status === "failed" ? "Agent did not respond" : null,
              screenshotVerified: status === "success" ? true : null,
              rawPayload: { secretLookingField: "fixture-raw-payload-must-not-leak" },
            },
          });
        }
        for (const type of spec.incidents ?? []) {
          const incident = await tx.incident.create({
            data: { tenantId, assetId: asset.id, type, openedAt: ago(3 * HOUR) },
          });
          incidentIds[`${spec.name}:${type}`] = incident.id;
        }
      }
    }
    const session: TenantSession = {
      tenantId,
      userId: user.id,
      clerkUserId: user.clerkUserId,
      role: user.role,
    };
    return { session, clientIds: ids, assetIds, incidentIds, integrationId: integration.id };
  });
}

describe("buildDayStrip", () => {
  const result = (iso: string, status: BackupStatus) => ({ startedAt: new Date(iso), status });

  it("gives one cell per UTC day, oldest first, ending today", () => {
    const strip = buildDayStrip([], NOW);
    expect(strip).toHaveLength(HISTORY_DAYS);
    expect(strip[0]!.date).toBe("2026-10-30");
    expect(strip.at(-1)!.date).toBe("2026-11-12");
    expect(strip.every((day) => day.worst === null && day.count === 0)).toBe(true);
  });

  it("shows the worst result of each day and counts them all", () => {
    const strip = buildDayStrip(
      [
        result("2026-11-12T01:00:00Z", "success"),
        result("2026-11-12T07:00:00Z", "failed"),
        result("2026-11-12T13:00:00Z", "success"),
        result("2026-11-11T02:00:00Z", "warning"),
        result("2026-11-11T08:00:00Z", "success"),
        result("2026-11-10T02:00:00Z", "running"),
      ],
      NOW,
    );
    expect(strip.at(-1)).toEqual({ date: "2026-11-12", worst: "failed", count: 3 });
    expect(strip.at(-2)).toEqual({ date: "2026-11-11", worst: "warning", count: 2 });
    expect(strip.at(-3)).toEqual({ date: "2026-11-10", worst: "running", count: 1 });
    expect(strip.at(-4)).toEqual({ date: "2026-11-09", worst: null, count: 0 });
  });

  it("puts results on the right side of midnight UTC", () => {
    const strip = buildDayStrip(
      [result("2026-11-11T23:59:59.999Z", "failed"), result("2026-11-12T00:00:00.000Z", "success")],
      NOW,
    );
    expect(strip.at(-2)).toMatchObject({ date: "2026-11-11", worst: "failed", count: 1 });
    expect(strip.at(-1)).toMatchObject({ date: "2026-11-12", worst: "success", count: 1 });
  });

  it("leaves out results older than the period, and any dated in the future", () => {
    const strip = buildDayStrip(
      [
        result("2026-10-29T23:59:59Z", "failed"), // one second before the first day
        result("2026-10-30T00:00:00Z", "warning"), // first moment of the first day
        result("2026-11-13T00:00:01Z", "failed"), // tomorrow
      ],
      NOW,
    );
    expect(strip[0]).toEqual({ date: "2026-10-30", worst: "warning", count: 1 });
    expect(strip.reduce((sum, day) => sum + day.count, 0)).toBe(1);
  });

  it("supports other lengths", () => {
    expect(buildDayStrip([], NOW, 7).map((d) => d.date)).toEqual([
      "2026-11-06",
      "2026-11-07",
      "2026-11-08",
      "2026-11-09",
      "2026-11-10",
      "2026-11-11",
      "2026-11-12",
    ]);
  });
});

describe("getFleetOverview", () => {
  it("ranks clients worst first: red, amber, green, then nothing watched", async () => {
    const { session } = await tenant({
      "Green Co": [
        { name: "g1", status: "success" },
        { name: "g2", status: "running" },
      ],
      "Empty Co": [],
      "Amber Co": [
        { name: "a1", status: "success" },
        { name: "a2", status: "warning" },
      ],
      "Red Co": [
        { name: "r1", status: "failed" },
        { name: "r2", status: "success" },
      ],
      "Redder Co": [
        { name: "x1", status: "failed" },
        { name: "x2", status: "missed" },
      ],
      "All Archived Co": [{ name: "z1", status: "failed", archived: true }],
    });
    const overview = await getFleetOverview({ db }, session, NOW);

    expect(overview.clients.map((c) => [c.name, c.summary.health, c.summary.affected])).toEqual([
      ["Redder Co", "red", 2],
      ["Red Co", "red", 1],
      ["Amber Co", "amber", 1],
      ["Green Co", "green", 0],
      ["All Archived Co", "none", 0],
      ["Empty Co", "none", 0],
    ]);
    expect(overview.health).toEqual({ red: 2, amber: 1, green: 1, none: 2 });
    expect(overview.assets).toEqual({
      watched: 8,
      excluded: 1,
      counts: { success: 3, warning: 1, failed: 2, missed: 1, running: 1, unknown: 0 },
    });
  });

  it("leaves paused, archived and muted assets out of health, and counts them as excluded", async () => {
    const { session } = await tenant({
      "Quiet Co": [
        { name: "ok", status: "success" },
        { name: "paused", status: "failed", paused: true },
        { name: "archived", status: "missed", archived: true },
        { name: "muted", status: "failed", mutedUntil: new Date(NOW.getTime() + DAY) },
        { name: "mute-expired", status: "warning", mutedUntil: ago(HOUR) },
      ],
    });
    const [client] = (await getFleetOverview({ db }, session, NOW)).clients;
    expect(client!.summary).toMatchObject({
      health: "amber",
      watched: 2,
      excluded: 3,
      affected: 1,
    });
  });

  it("turns healthy clients amber while their integration is failing to sync", async () => {
    const { session } = await tenant(
      { "Fine Co": [{ name: "f1", status: "success" }] },
      { syncStatus: "error" },
    );
    const overview = await getFleetOverview({ db }, session, NOW);
    expect(overview.clients[0]!.summary.health).toBe("amber");
    expect(overview.integrations).toMatchObject({ total: 1, failing: 1, waiting: 0 });
  });

  it("shows an asset as unknown once its window closes behind a failing integration", async () => {
    // Nothing has been read from the vendor for 30 hours.
    const { session } = await tenant(
      {
        "Blind Co": [
          // Daily, last backup 31 hours ago: its 26-hour window closed unseen.
          { name: "daily", status: "success", lastBackupHoursAgo: 31 },
          { name: "daily-running", status: "running", lastBackupHoursAgo: 31 },
          // Weekly: its last backup still covers it, whatever has happened since.
          { name: "weekly", status: "success", lastBackupHoursAgo: 31, frequencyHours: 168 },
          // Known problems stay exactly as they were.
          { name: "was-failed", status: "failed", lastBackupHoursAgo: 80 },
          { name: "was-missed", status: "missed", lastBackupHoursAgo: 80 },
          { name: "was-warning", status: "warning", lastBackupHoursAgo: 31 },
          // Not watched: left alone and left out.
          {
            name: "muted",
            status: "success",
            lastBackupHoursAgo: 31,
            mutedUntil: new Date(NOW.getTime() + DAY),
          },
        ],
      },
      {
        syncStatus: "error",
        lastSyncHoursAgo: 30,
        failures: {
          count: 9,
          sinceHoursAgo: 29,
          kind: "network",
          message: "The vendor API could not be reached.",
        },
      },
    );
    const overview = await getFleetOverview({ db }, session, NOW);

    expect(overview.assets).toEqual({
      watched: 6,
      excluded: 1,
      counts: { success: 1, warning: 1, failed: 1, missed: 1, running: 0, unknown: 2 },
    });
    expect(overview.clients[0]!.summary).toMatchObject({ health: "red", affected: 2 });
    expect(overview.integrations).toEqual({
      total: 1,
      failing: 1,
      stalled: 0,
      waiting: 0,
      lastSyncAt: ago(30 * HOUR),
      problems: [
        {
          id: expect.any(String) as string,
          name: "Demo data",
          vendor: "mock",
          state: "unhealthy",
          since: ago(29 * HOUR),
          needsAction: false,
          error: "The vendor API could not be reached.",
          lastSyncAt: ago(30 * HOUR),
          // The two shown as unknown. The three with a known problem keep
          // it and are not counted again; nor are the weekly and muted ones.
          unconfirmedAssets: 2,
        },
      ],
    });
  });

  it("does the same when nothing is failing but nothing is arriving: the worker has stopped", async () => {
    // No sync has recorded an error. The last one succeeded, 30 hours ago.
    const { session } = await tenant(
      {
        "Quiet Co": [
          { name: "daily", status: "success", lastBackupHoursAgo: 31 },
          { name: "weekly", status: "success", lastBackupHoursAgo: 31, frequencyHours: 168 },
        ],
      },
      { syncStatus: "ok", lastSyncHoursAgo: 30 },
    );
    const overview = await getFleetOverview({ db }, session, NOW);

    expect(overview.assets.counts).toMatchObject({ success: 1, unknown: 1 });
    expect(overview.clients[0]!.summary.health).toBe("amber");
    expect(overview.integrations).toMatchObject({ failing: 0, stalled: 1, waiting: 0 });
    expect(overview.integrations.problems).toEqual([
      expect.objectContaining({
        state: "stalled",
        since: ago(30 * HOUR),
        error: null,
        needsAction: false,
        unconfirmedAssets: 1,
      }),
    ]);
  });

  it("treats a sync stuck in progress, and one that never started, as stalled", async () => {
    const stuck = await tenant(
      { "Stuck Co": [{ name: "a", status: "success", lastBackupHoursAgo: 31 }] },
      { syncStatus: "running", lastSyncHoursAgo: 30 },
    );
    const stuckView = await getFleetOverview({ db }, stuck.session, NOW);
    expect(stuckView.integrations).toMatchObject({ stalled: 1 });
    expect(stuckView.assets.counts.unknown).toBe(1);

    const never = await tenant({}, { syncStatus: "never" });
    await db.withTenant(never.session.tenantId, ({ tx }) =>
      tx.integration.updateMany({ data: { createdAt: ago(3 * HOUR) } }),
    );
    const neverView = await getFleetOverview({ db }, never.session, NOW);
    expect(neverView.integrations).toMatchObject({ stalled: 1, waiting: 0 });
  });

  it("leaves stored statuses alone while the data is fresh", async () => {
    // A daily asset 31 hours without a backup, but synced five minutes ago:
    // the sync has seen it and stored what it found. Reading adds nothing.
    const { session } = await tenant({
      "Fresh Co": [
        { name: "a", status: "success", lastBackupHoursAgo: 31 },
        { name: "b", status: "missed", lastBackupHoursAgo: 31 },
        { name: "c", status: "running", lastBackupHoursAgo: 31 },
      ],
    });
    const overview = await getFleetOverview({ db }, session, NOW);
    expect(overview.assets.counts).toMatchObject({ success: 1, missed: 1, running: 1, unknown: 0 });
    expect(overview.integrations.problems).toEqual([]);
  });

  it("one failed sync does not turn assets unknown while their windows are still open", async () => {
    const { session } = await tenant(
      { "Brief Co": [{ name: "a", status: "success", lastBackupHoursAgo: 6 }] },
      {
        syncStatus: "error",
        lastSyncHoursAgo: 0.5,
        failures: { count: 1, sinceHoursAgo: 0.25, kind: "vendor", message: "HTTP 503." },
      },
    );
    const overview = await getFleetOverview({ db }, session, NOW);
    expect(overview.assets.counts).toMatchObject({ success: 1, unknown: 0 });
    // Still amber: the client's data is not current.
    expect(overview.clients[0]!.summary.health).toBe("amber");
    expect(overview.integrations.problems).toEqual([
      expect.objectContaining({ state: "retrying", unconfirmedAssets: 0, needsAction: false }),
    ]);
  });

  it("keeps treating a run of failures as failing while the next attempt is in progress", async () => {
    const { session } = await tenant(
      { "Retry Co": [{ name: "a", status: "success", lastBackupHoursAgo: 31 }] },
      {
        syncStatus: "running",
        lastSyncHoursAgo: 0.5,
        failures: { count: 2, sinceHoursAgo: 0.4, kind: "network", message: "Unreachable." },
      },
    );
    const overview = await getFleetOverview({ db }, session, NOW);
    expect(overview.integrations).toMatchObject({ failing: 1, stalled: 0 });
    expect(overview.assets.counts.unknown).toBe(1);
  });

  it("says when a rejected key needs replacing, at the first failure", async () => {
    const { session } = await tenant(
      { "Key Co": [{ name: "a", status: "success", lastBackupHoursAgo: 6 }] },
      {
        syncStatus: "error",
        lastSyncHoursAgo: 0.5,
        failures: { count: 1, sinceHoursAgo: 0.25, kind: "auth", message: "Rejected." },
      },
    );
    const [problem] = (await getFleetOverview({ db }, session, NOW)).integrations.problems;
    expect(problem).toMatchObject({ state: "unhealthy", needsAction: true, error: "Rejected." });
  });

  it("uses the workspace's grace period and the configured sync interval", async () => {
    // 31 hours since the last backup is inside a 24 + 10 hour window.
    const generous = await tenant(
      { "Grace Co": [{ name: "a", status: "success", lastBackupHoursAgo: 31 }] },
      { syncStatus: "ok", lastSyncHoursAgo: 30, graceHours: 10 },
    );
    const view = await getFleetOverview({ db }, generous.session, NOW);
    expect(view.assets.counts).toMatchObject({ success: 1, unknown: 0 });

    // Fifty minutes without a sync is stalled at 15-minute syncs, normal at hourly ones.
    const { session } = await tenant(
      { "Interval Co": [{ name: "a", status: "success", lastBackupHoursAgo: 6 }] },
      { syncStatus: "ok", lastSyncHoursAgo: 50 / 60 },
    );
    expect((await getFleetOverview({ db }, session, NOW)).integrations.stalled).toBe(1);
    const hourly = await getFleetOverview({ db, syncIntervalMinutes: 60 }, session, NOW);
    expect(hourly.integrations).toMatchObject({ stalled: 0, problems: [] });
  });

  it("counts open incidents per client and in total, ignoring closed ones", async () => {
    const { session, incidentIds } = await tenant({
      "One Co": [{ name: "a", status: "failed", incidents: ["failed", "missed"] }],
      "Two Co": [{ name: "b", status: "missed", incidents: ["missed"] }],
      "Calm Co": [{ name: "c", status: "success" }],
    });
    await db.withTenant(session.tenantId, ({ tx }) =>
      tx.incident.update({ where: { id: incidentIds["b:missed"]! }, data: { closedAt: NOW } }),
    );
    const overview = await getFleetOverview({ db }, session, NOW);
    expect(Object.fromEntries(overview.clients.map((c) => [c.name, c.openIncidents]))).toEqual({
      "One Co": 2,
      "Two Co": 0,
      "Calm Co": 0,
    });
    expect(overview.openIncidents).toBe(2);
  });

  it("reports sync state: last successful sync, and integrations still waiting", async () => {
    const synced = await tenant({ "A Co": [{ name: "a", status: "success" }] });
    expect((await getFleetOverview({ db }, synced.session, NOW)).integrations).toEqual({
      total: 1,
      failing: 0,
      stalled: 0,
      waiting: 0,
      lastSyncAt: ago(5 * 60_000),
      problems: [],
    });

    const waiting = await tenant({}, { syncStatus: "never" });
    expect((await getFleetOverview({ db }, waiting.session, NOW)).integrations).toEqual({
      total: 1,
      failing: 0,
      stalled: 0,
      waiting: 1,
      lastSyncAt: null,
      problems: [],
    });
  });

  it("is empty, not an error, for a workspace with nothing connected", async () => {
    const tenantId = await db.provisionTenant({ clerkOrgId: `org_${randomUUID()}`, name: "New" });
    const session: TenantSession = {
      tenantId,
      userId: randomUUID(),
      clerkUserId: "u",
      role: "owner",
    };
    expect(await getFleetOverview({ db }, session, NOW)).toEqual({
      clients: [],
      health: { red: 0, amber: 0, green: 0, none: 0 },
      assets: {
        watched: 0,
        excluded: 0,
        counts: { success: 0, warning: 0, failed: 0, missed: 0, running: 0, unknown: 0 },
      },
      openIncidents: 0,
      integrations: {
        total: 0,
        failing: 0,
        stalled: 0,
        waiting: 0,
        lastSyncAt: null,
        problems: [],
      },
    });
  });

  it("shows one tenant only its own clients", async () => {
    const mine = await tenant({ "Mine Co": [{ name: "m", status: "success" }] });
    const theirs = await tenant({
      "Theirs Co": [{ name: "t", status: "failed", incidents: ["failed"] }],
    });
    const overview = await getFleetOverview({ db }, mine.session, NOW);
    expect(overview.clients.map((c) => c.name)).toEqual(["Mine Co"]);
    expect(overview.openIncidents).toBe(0);
    expect(
      (await getFleetOverview({ db }, theirs.session, NOW)).clients.map((c) => c.name),
    ).toEqual(["Theirs Co"]);
  });

  it("contains no credentials", async () => {
    const { session } = await tenant({ "A Co": [{ name: "a", status: "success" }] });
    const text = JSON.stringify(await getFleetOverview({ db }, session, NOW));
    expect(text).not.toContain("fixture-ciphertext-must-not-leak");
    expect(text).not.toContain("credentials");
  });
});

describe("getClientDetail", () => {
  it("lists assets worst first, with the ones not being watched last", async () => {
    const { session, clientIds } = await tenant({
      "Mixed Co": [
        { name: "ok-b", status: "success" },
        { name: "ok-a", status: "success" },
        { name: "archived-failed", status: "failed", archived: true },
        { name: "warned", status: "warning" },
        { name: "missed", status: "missed" },
        { name: "failed", status: "failed" },
        { name: "unknown", status: "unknown" },
        { name: "running", status: "running" },
      ],
    });
    const detail = (await getClientDetail({ db }, session, clientIds["Mixed Co"]!, NOW))!;

    expect(detail.assets.map((a) => [a.name, a.watched])).toEqual([
      ["failed", true],
      ["missed", true],
      ["warned", true],
      ["unknown", true],
      ["running", true],
      ["ok-a", true],
      ["ok-b", true],
      ["archived-failed", false],
    ]);
    expect(detail).toMatchObject({
      name: "Mixed Co",
      summary: { health: "red", affected: 2, excluded: 1 },
    });
    expect(detail.assets[0]).toMatchObject({
      type: "agent",
      deviceName: "BDR01",
      integrationName: "Demo data",
      vendor: "mock",
      expectedFrequencyHours: 24,
    });
  });

  it("shows unconfirmed assets as unknown, says since when, and ranks them accordingly", async () => {
    const { session, clientIds } = await tenant(
      {
        "Blind Co": [
          { name: "weekly", status: "success", lastBackupHoursAgo: 31, frequencyHours: 168 },
          { name: "daily", status: "success", lastBackupHoursAgo: 31 },
          { name: "was-failed", status: "failed", lastBackupHoursAgo: 80 },
        ],
      },
      { syncStatus: "ok", lastSyncHoursAgo: 30 },
    );
    const detail = (await getClientDetail({ db }, session, clientIds["Blind Co"]!, NOW))!;

    expect(detail.assets.map((a) => [a.name, a.currentStatus, a.unconfirmedSince])).toEqual([
      // Its window closed long ago too, but what we last knew was a failure.
      ["was-failed", "failed", ago(30 * HOUR)],
      ["daily", "unknown", ago(30 * HOUR)],
      ["weekly", "success", null],
    ]);
    expect(detail.summary).toMatchObject({
      health: "red",
      counts: { failed: 1, unknown: 1, success: 1 },
    });

    // The same client once data is arriving again.
    await db.withTenant(session.tenantId, ({ tx }) =>
      tx.integration.updateMany({ data: { lastSyncAt: ago(60_000) } }),
    );
    const fresh = (await getClientDetail({ db }, session, clientIds["Blind Co"]!, NOW))!;
    expect(fresh.assets.map((a) => [a.name, a.currentStatus, a.unconfirmedSince])).toEqual([
      ["was-failed", "failed", null],
      ["daily", "success", null],
      ["weekly", "success", null],
    ]);
  });

  it("gives each asset a 14-day strip and its results, newest first", async () => {
    const { session, clientIds } = await tenant({
      "History Co": [
        {
          name: "dc01",
          status: "failed",
          results: [
            [2, "failed"],
            [10, "success"],
            [26, "success"],
            [50, "warning"],
            [14 * 24 + 20, "failed"], // older than the period
          ],
        },
        { name: "silent", status: "missed" },
      ],
    });
    const detail = (await getClientDetail({ db }, session, clientIds["History Co"]!, NOW))!;
    const dc01 = detail.assets.find((a) => a.name === "dc01")!;

    expect(dc01.days).toHaveLength(14);
    expect(dc01.days.at(-1)).toEqual({ date: "2026-11-12", worst: "failed", count: 2 });
    expect(dc01.days.at(-2)).toEqual({ date: "2026-11-11", worst: "success", count: 1 });
    expect(dc01.days.at(-3)).toEqual({ date: "2026-11-10", worst: "warning", count: 1 });
    expect(dc01.days.slice(0, 11).every((d) => d.worst === null)).toBe(true);

    expect(dc01.resultCount).toBe(4);
    expect(dc01.results.map((r) => r.status)).toEqual(["failed", "success", "success", "warning"]);
    expect(dc01.results[0]).toMatchObject({
      vendorStatusRaw: "FAILED",
      message: "Agent did not respond",
      screenshotVerified: null,
    });
    expect(dc01.results[1]).toMatchObject({ screenshotVerified: true, message: null });

    const silent = detail.assets.find((a) => a.name === "silent")!;
    expect(silent.results).toEqual([]);
    expect(silent.days.every((d) => d.count === 0)).toBe(true);
  });

  it("lists at most 50 results per asset but still counts and charts them all", async () => {
    const hourly: [number, BackupStatus][] = Array.from({ length: 70 }, (_, i) => [
      i + 1,
      "success",
    ]);
    const { session, clientIds } = await tenant({
      "Busy Co": [{ name: "hourly", status: "success", results: hourly }],
    });
    const [asset] = (await getClientDetail({ db }, session, clientIds["Busy Co"]!, NOW))!.assets;

    expect(asset!.results).toHaveLength(RESULTS_PER_ASSET);
    expect(asset!.resultCount).toBe(70);
    expect(asset!.days.reduce((sum, day) => sum + day.count, 0)).toBe(70);
    const starts = asset!.results.map((r) => r.startedAt.getTime());
    expect(starts).toEqual([...starts].sort((a, b) => b - a));
  });

  it("lists open incidents with who acknowledged them", async () => {
    const { session, clientIds, incidentIds } = await tenant({
      "Trouble Co": [
        { name: "a", status: "failed", incidents: ["failed", "missed"] },
        { name: "b", status: "success" },
      ],
    });
    await acknowledgeIncident({ db }, session, incidentIds["a:failed"]!);
    const detail = (await getClientDetail({ db }, session, clientIds["Trouble Co"]!, NOW))!;

    expect(detail.openIncidents.map((i) => [i.type, i.assetName, i.acknowledgedBy])).toEqual(
      expect.arrayContaining([
        ["failed", "a", "Alex Tech"],
        ["missed", "a", null],
      ]),
    );
    expect(detail.openIncidents).toHaveLength(2);
  });

  it("never returns the vendor's raw payload or any credentials", async () => {
    const { session, clientIds } = await tenant({
      "Leak Check Co": [{ name: "a", status: "success", results: [[1, "success"]] }],
    });
    const text = JSON.stringify(
      await getClientDetail({ db }, session, clientIds["Leak Check Co"]!, NOW),
    );
    for (const forbidden of [
      "fixture-raw-payload-must-not-leak",
      "rawPayload",
      "fixture-ciphertext-must-not-leak",
      "credentials",
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("returns null for another tenant's client, a made-up id and a malformed one", async () => {
    const mine = await tenant({ "Mine Co": [{ name: "m", status: "success" }] });
    const theirs = await tenant({ "Theirs Co": [{ name: "t", status: "success" }] });

    expect(
      await getClientDetail({ db }, mine.session, theirs.clientIds["Theirs Co"]!, NOW),
    ).toBeNull();
    expect(await getClientDetail({ db }, mine.session, randomUUID(), NOW)).toBeNull();
    for (const bad of ["", "not-a-uuid", "' OR 1=1 --", "../integrations"]) {
      expect(await getClientDetail({ db }, mine.session, bad, NOW)).toBeNull();
    }
    expect(
      await getClientDetail({ db }, mine.session, mine.clientIds["Mine Co"]!, NOW),
    ).not.toBeNull();
  });

  it("handles a client with no assets", async () => {
    const { session, clientIds } = await tenant({ "Bare Co": [] });
    expect(await getClientDetail({ db }, session, clientIds["Bare Co"]!, NOW)).toMatchObject({
      name: "Bare Co",
      summary: { health: "none", watched: 0 },
      assets: [],
      openIncidents: [],
    });
  });
});

describe("acknowledgeIncident", () => {
  const incidentRow = (session: TenantSession, id: string) =>
    db.withTenant(session.tenantId, ({ tx }) => tx.incident.findUnique({ where: { id } }));
  const auditActions = (session: TenantSession) =>
    db.withTenant(session.tenantId, ({ tx }) =>
      tx.auditLog.findMany({ orderBy: { createdAt: "asc" } }),
    );

  it("records who acknowledged it and when, and audits it; it stays open", async () => {
    const { session, incidentIds, assetIds } = await tenant({
      "Ack Co": [{ name: "a", status: "failed", incidents: ["failed"] }],
    });
    const id = incidentIds["a:failed"]!;
    const state = await acknowledgeIncident({ db, ip: "203.0.113.5" }, session, id);

    expect(state).toEqual({ status: "ok", message: "Acknowledged." });
    const row = (await incidentRow(session, id))!;
    expect(row).toMatchObject({ acknowledgedByUserId: session.userId, closedAt: null });
    expect(row.acknowledgedAt).not.toBeNull();
    expect(await auditActions(session)).toMatchObject([
      {
        action: "incident.acknowledged",
        actorUserId: session.userId,
        targetId: id,
        ip: "203.0.113.5",
        metadata: { type: "failed", assetId: assetIds.a },
      },
    ]);
  });

  it("is available to technicians as well as owners", async () => {
    for (const role of ["technician", "owner"] as const) {
      const { session, incidentIds } = await tenant(
        { "Role Co": [{ name: "a", status: "missed", incidents: ["missed"] }] },
        { role },
      );
      expect((await acknowledgeIncident({ db }, session, incidentIds["a:missed"]!)).status).toBe(
        "ok",
      );
    }
  });

  it("does nothing the second time: the first acknowledgement stands", async () => {
    const { session, incidentIds } = await tenant({
      "Twice Co": [{ name: "a", status: "failed", incidents: ["failed"] }],
    });
    const id = incidentIds["a:failed"]!;
    await acknowledgeIncident({ db }, session, id);
    const first = (await incidentRow(session, id))!;

    expect(await acknowledgeIncident({ db }, session, id)).toEqual({
      status: "ok",
      message: "Already acknowledged.",
    });
    expect((await incidentRow(session, id))!.acknowledgedAt).toEqual(first.acknowledgedAt);
    expect(await auditActions(session)).toHaveLength(1);
  });

  it("refuses an incident that has already been resolved", async () => {
    const { session, incidentIds } = await tenant({
      "Closed Co": [{ name: "a", status: "success", incidents: ["failed"] }],
    });
    const id = incidentIds["a:failed"]!;
    await db.withTenant(session.tenantId, ({ tx }) =>
      tx.incident.update({ where: { id }, data: { closedAt: NOW } }),
    );
    expect(await acknowledgeIncident({ db }, session, id)).toEqual({
      status: "error",
      message: "That incident has already been resolved.",
    });
    expect((await incidentRow(session, id))!.acknowledgedAt).toBeNull();
  });

  it("cannot acknowledge another tenant's incident", async () => {
    const mine = await tenant({ "Mine Co": [{ name: "m", status: "success" }] });
    const theirs = await tenant({
      "Theirs Co": [{ name: "t", status: "failed", incidents: ["failed"] }],
    });
    const theirId = theirs.incidentIds["t:failed"]!;

    expect(await acknowledgeIncident({ db }, mine.session, theirId)).toEqual({
      status: "error",
      message: "That incident no longer exists.",
    });
    expect((await incidentRow(theirs.session, theirId))!.acknowledgedAt).toBeNull();
    expect(await auditActions(mine.session)).toEqual([]);
  });

  it("treats a malformed id as not found", async () => {
    const { session } = await tenant({});
    for (const bad of ["", "nope", "' OR 1=1 --"]) {
      expect((await acknowledgeIncident({ db }, session, bad)).status).toBe("error");
    }
  });
});
