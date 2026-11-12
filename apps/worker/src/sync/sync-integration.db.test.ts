import { randomBytes, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import {
  AuthError,
  createConnector,
  MockConnector,
  type Connector,
  type VendorResult,
} from "@valtrexia/connectors";
import { BACKUP_STATUSES } from "@valtrexia/core";
import { createLogger, LocalKeyProvider, Secret } from "@valtrexia/core/server";
import { createDb, createIntegration, type Db } from "@valtrexia/db";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  describeFailure,
  FIRST_SYNC_LOOKBACK_DAYS,
  IntegrationNotFoundError,
  SYNC_OVERLAP_HOURS,
  syncIntegration,
  type SyncDeps,
} from "./sync-integration";

const urls = inject("databaseUrls");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = new Date("2026-11-12T12:00:00Z");
const after = (ms: number) => new Date(T0.getTime() + ms);

let db: Db;
const keyProvider = new LocalKeyProvider(randomBytes(32).toString("base64"));
const logLines: string[] = [];
const logger = createLogger({
  name: "sync-test",
  level: "debug",
  destination: new Writable({
    write(chunk: Buffer, _encoding, done) {
      logLines.push(chunk.toString());
      done();
    },
  }),
});

beforeAll(() => {
  db = createDb({ url: urls.app });
});
afterAll(async () => {
  await db.disconnect();
});

function deps(now: Date, overrides: Partial<SyncDeps> = {}): SyncDeps {
  return { db, keyProvider, logger, allowMock: true, now: () => now, ...overrides };
}

/** A fresh tenant with one demo-vendor integration. */
async function newTenant(credentials: unknown = { seed: "demo" }) {
  const tenantId = await db.provisionTenant({
    clerkOrgId: `org_${randomUUID()}`,
    name: "Sync test MSP",
  });
  const integration = await db.withTenant(tenantId, (context) =>
    createIntegration(context, keyProvider, {
      vendor: "mock",
      name: "Demo data",
      credentials: new Secret(credentials),
      actorUserId: null,
    }),
  );
  return { tenantId, integrationId: integration.id };
}

/** What the mock vendor itself reports at `now`, to compare the database against. */
async function vendorTruth(now: Date, since: Date) {
  const connector = new MockConnector({ seed: "demo" }, { now: () => now });
  const clients = await connector.listClients();
  const assets = (
    await Promise.all(clients.map((c) => connector.listAssets(c.vendorClientId)))
  ).flat();
  const results = await connector.listResults(since);
  return { connector, clients, assets, results };
}

const counts = (tenantId: string) =>
  db.withTenant(tenantId, async ({ tx }) => ({
    clients: await tx.client.count(),
    mappings: await tx.vendorClientMapping.count(),
    assets: await tx.asset.count(),
    results: await tx.backupResult.count(),
  }));

describe("syncIntegration: first sync", () => {
  it("stores exactly what the vendor reports for the last 14 days", async () => {
    const target = await newTenant();
    const summary = await syncIntegration(deps(T0), target);

    const since = after(-FIRST_SYNC_LOOKBACK_DAYS * DAY);
    const truth = await vendorTruth(T0, since);
    expect(summary.since).toEqual(since);
    expect(summary).toMatchObject({
      clients: 12,
      assets: truth.assets.length,
      resultsFetched: truth.results.length,
      resultsCreated: truth.results.length,
      resultsUpdated: 0,
      resultsSkipped: 0,
    });
    expect(await counts(target.tenantId)).toEqual({
      clients: 12,
      mappings: 12,
      assets: truth.assets.length,
      results: truth.results.length,
    });
  });

  it("normalizes each result and keeps the vendor's raw status and payload", async () => {
    const target = await newTenant();
    await syncIntegration(deps(T0), target);
    const truth = await vendorTruth(T0, after(-FIRST_SYNC_LOOKBACK_DAYS * DAY));
    const expected = new Map(truth.results.map((r) => [r.vendorResultId, r]));

    const stored = await db.withTenant(target.tenantId, ({ tx }) => tx.backupResult.findMany());
    expect(stored).toHaveLength(expected.size);
    for (const row of stored) {
      const source = expected.get(row.vendorResultId)!;
      expect(row.status).toBe(truth.connector.normalizeStatus(source.rawPayload));
      expect(row.vendorStatusRaw).toBe(source.vendorStatusRaw);
      expect(row.rawPayload).toEqual(source.rawPayload);
      expect(row.startedAt).toEqual(source.startedAt);
      expect(row.endedAt).toEqual(source.endedAt);
      expect(row.screenshotVerified).toBe(source.screenshotVerified);
    }
    // The fixture exercises every status a vendor can report.
    const seen = new Set(stored.map((row) => row.status));
    expect([...seen].sort()).toEqual(BACKUP_STATUSES.filter((s) => s !== "missed").sort());
  });

  it("copies asset details, including the vendor's schedule and paused/archived flags", async () => {
    const target = await newTenant();
    await syncIntegration(deps(T0), target);
    const truth = await vendorTruth(T0, T0);
    const assets = await db.withTenant(target.tenantId, ({ tx }) => tx.asset.findMany());
    const byVendorId = new Map(assets.map((a) => [a.vendorAssetId, a]));

    for (const source of truth.assets) {
      expect(byVendorId.get(source.vendorAssetId)).toMatchObject({
        name: source.name,
        type: source.type,
        deviceName: source.deviceName,
        isPaused: source.isPaused,
        isArchived: source.isArchived,
        expectedFrequencyHours: source.expectedFrequencyHours,
        firstSeenAt: T0,
        lastSeenAt: T0,
      });
    }
  });

  it("marks the integration as synced", async () => {
    const target = await newTenant();
    await syncIntegration(deps(T0), target);
    const integration = await db.withTenant(target.tenantId, ({ tx }) =>
      tx.integration.findUniqueOrThrow({ where: { id: target.integrationId } }),
    );
    expect(integration).toMatchObject({
      syncStatus: "ok",
      lastSyncAt: T0,
      lastSyncStartedAt: T0,
      lastSyncError: null,
    });
  });
});

describe("syncIntegration: asset status", () => {
  it("derives every asset's status from its latest result and the missed-backup rule", async () => {
    const target = await newTenant();
    const summary = await syncIntegration(deps(T0), target);
    const assets = await db.withTenant(target.tenantId, ({ tx }) =>
      tx.asset.findMany({ include: { backupResults: { orderBy: { startedAt: "desc" } } } }),
    );

    for (const asset of assets) {
      const latest = asset.backupResults[0];
      expect(asset.lastResultAt ?? null).toEqual(latest?.startedAt ?? null);
      expect(asset.lastResultStatus ?? null).toBe(latest?.status ?? null);

      const completed = asset.backupResults
        .filter((r) => r.status === "success" || r.status === "warning")
        .map((r) => (r.endedAt ?? r.startedAt).getTime());
      expect(asset.lastSuccessAt?.getTime() ?? null).toBe(
        completed.length ? Math.max(...completed) : null,
      );

      if (asset.currentStatus === "missed") {
        const overdueSince = (asset.lastSuccessAt ?? asset.firstSeenAt).getTime();
        expect(T0.getTime() - overdueSince).toBeGreaterThan(
          (asset.expectedFrequencyHours + 2) * HOUR,
        );
        expect(asset.isPaused || asset.isArchived).toBe(false);
      } else {
        expect(asset.currentStatus).toBe(asset.lastResultStatus ?? "unknown");
      }
    }

    const tally = Object.fromEntries(BACKUP_STATUSES.map((s) => [s, 0]));
    for (const asset of assets) tally[asset.currentStatus]! += 1;
    expect(summary.statusCounts).toEqual(tally);
    expect(summary.verdicts).toHaveLength(assets.length);
  });

  it("flags the silent asset as missed while remembering its last result was a success", async () => {
    const target = await newTenant();
    await syncIntegration(deps(T0), target);
    const missed = await db.withTenant(target.tenantId, ({ tx }) =>
      tx.asset.findMany({ where: { currentStatus: "missed" } }),
    );
    expect(missed.length).toBeGreaterThan(0);
    for (const asset of missed) expect(asset.lastResultStatus).toBe("success");
  });

  it("gives a never-backed-up asset its grace window, then flags it", async () => {
    const target = await newTenant();
    const first = await syncIntegration(deps(T0), target);
    const never = await db.withTenant(target.tenantId, ({ tx }) =>
      tx.asset.findFirstOrThrow({
        where: { lastResultAt: null, isPaused: false, isArchived: false },
      }),
    );
    expect(never.currentStatus).toBe("unknown");
    expect(first.verdicts.find((v) => v.assetId === never.id)?.verdict.state).toBe("ok");

    // 24 h frequency + 2 h grace after discovery, plus a little.
    await syncIntegration(deps(after(27 * HOUR)), target);
    const later = await db.withTenant(target.tenantId, ({ tx }) =>
      tx.asset.findUniqueOrThrow({ where: { id: never.id } }),
    );
    expect(later.currentStatus).toBe("missed");
    expect(later.lastResultStatus).toBeNull();
  });

  it("never flags paused or archived assets as missed", async () => {
    const target = await newTenant();
    await syncIntegration(deps(T0), target);
    const summary = await syncIntegration(deps(after(10 * DAY)), target);
    const idle = await db.withTenant(target.tenantId, ({ tx }) =>
      tx.asset.findMany({ where: { OR: [{ isPaused: true }, { isArchived: true }] } }),
    );
    expect(idle).toHaveLength(2);
    for (const asset of idle) {
      expect(asset.currentStatus).toBe("unknown");
      expect(summary.verdicts.find((v) => v.assetId === asset.id)?.verdict.state).toBe(
        "suppressed",
      );
    }
  });

  it("respects a mute set by a technician", async () => {
    const target = await newTenant();
    await syncIntegration(deps(T0), target);
    const victim = await db.withTenant(target.tenantId, ({ tx }) =>
      tx.asset.findFirstOrThrow({ where: { currentStatus: "missed" } }),
    );
    await db.withTenant(target.tenantId, ({ tx }) =>
      tx.asset.update({ where: { id: victim.id }, data: { mutedUntil: after(DAY) } }),
    );
    const summary = await syncIntegration(deps(after(HOUR)), target);
    expect(summary.verdicts.find((v) => v.assetId === victim.id)?.verdict).toEqual({
      state: "suppressed",
      reason: "muted",
    });
  });
});

describe("syncIntegration: running again", () => {
  it("is idempotent: the same moment twice changes nothing", async () => {
    const target = await newTenant();
    await syncIntegration(deps(T0), target);
    const before = await counts(target.tenantId);
    const snapshot = await db.withTenant(target.tenantId, ({ tx }) =>
      tx.asset.findMany({ orderBy: { id: "asc" }, omit: { updatedAt: true } }),
    );

    const again = await syncIntegration(deps(T0), target);
    expect(again).toMatchObject({ resultsCreated: 0, resultsUpdated: 0 });
    expect(await counts(target.tenantId)).toEqual(before);
    expect(
      await db.withTenant(target.tenantId, ({ tx }) =>
        tx.asset.findMany({ orderBy: { id: "asc" }, omit: { updatedAt: true } }),
      ),
    ).toEqual(snapshot);
  });

  it("later syncs re-read 24 hours before the previous sync, not 14 days", async () => {
    const target = await newTenant();
    const sinces: Date[] = [];
    const spy: SyncDeps["connectorFactory"] = (vendor, credentials, connectorDeps) => {
      const real = createConnector(vendor, credentials, connectorDeps);
      const wrapped: Connector = {
        vendor: real.vendor,
        testConnection: () => real.testConnection(),
        listClients: () => real.listClients(),
        listAssets: (id) => real.listAssets(id),
        listResults: (since) => {
          sinces.push(since);
          return real.listResults(since);
        },
        normalizeStatus: (raw) => real.normalizeStatus(raw),
      };
      return wrapped;
    };

    await syncIntegration(deps(T0, { connectorFactory: spy }), target);
    await syncIntegration(deps(after(15 * 60_000), { connectorFactory: spy }), target);
    expect(sinces).toEqual([
      after(-FIRST_SYNC_LOOKBACK_DAYS * DAY),
      after(-SYNC_OVERLAP_HOURS * HOUR),
    ]);
  });

  it("adds new results and completes ones that were running", async () => {
    const target = await newTenant();
    await syncIntegration(deps(T0), target);
    const running = await db.withTenant(target.tenantId, ({ tx }) =>
      tx.backupResult.findMany({ where: { status: "running" } }),
    );
    expect(running.length).toBeGreaterThan(0);
    const before = await counts(target.tenantId);

    const summary = await syncIntegration(deps(after(23 * HOUR)), target);
    expect(summary.resultsCreated).toBeGreaterThan(0);
    expect(summary.resultsUpdated).toBeGreaterThanOrEqual(running.length);
    expect((await counts(target.tenantId)).results).toBe(before.results + summary.resultsCreated);

    const finished = await db.withTenant(target.tenantId, ({ tx }) =>
      tx.backupResult.findMany({ where: { id: { in: running.map((r) => r.id) } } }),
    );
    for (const row of finished) {
      expect(row.status).not.toBe("running");
      expect(row.endedAt).not.toBeNull();
      expect(row.vendorStatusRaw).not.toBe("RUNNING");
    }
  });

  it("many syncs over several days never duplicate a result", async () => {
    const target = await newTenant();
    for (const hours of [0, 0.25, 0.5, 6, 30, 31, 80]) {
      await syncIntegration(deps(after(hours * HOUR)), target);
    }
    const truth = await vendorTruth(after(80 * HOUR), after(-FIRST_SYNC_LOOKBACK_DAYS * DAY));
    const stored = await db.withTenant(target.tenantId, ({ tx }) =>
      tx.backupResult.findMany({ select: { vendorResultId: true, status: true } }),
    );
    expect(stored).toHaveLength(truth.results.length);
    expect(new Set(stored.map((r) => r.vendorResultId)).size).toBe(stored.length);
    const expected = new Map(
      truth.results.map((r: VendorResult) => [
        r.vendorResultId,
        truth.connector.normalizeStatus(r.rawPayload),
      ]),
    );
    for (const row of stored) expect(row.status).toBe(expected.get(row.vendorResultId));
  });

  it("does not overwrite a frequency the MSP has tuned", async () => {
    const target = await newTenant();
    await syncIntegration(deps(T0), target);
    const asset = await db.withTenant(target.tenantId, ({ tx }) =>
      tx.asset.findFirstOrThrow({ where: { expectedFrequencyHours: 24 } }),
    );
    await db.withTenant(target.tenantId, ({ tx }) =>
      tx.asset.update({ where: { id: asset.id }, data: { expectedFrequencyHours: 48 } }),
    );
    await syncIntegration(deps(after(HOUR)), target);
    const reread = await db.withTenant(target.tenantId, ({ tx }) =>
      tx.asset.findUniqueOrThrow({ where: { id: asset.id } }),
    );
    expect(reread.expectedFrequencyHours).toBe(48);
  });

  it("attaches to an existing client of the same name instead of creating a second", async () => {
    const tenantId = await db.provisionTenant({ clerkOrgId: `org_${randomUUID()}`, name: "X" });
    const existing = await db.withTenant(tenantId, ({ tx }) =>
      tx.client.create({ data: { tenantId, name: "Harborview Dental Group" } }),
    );
    const integration = await db.withTenant(tenantId, (context) =>
      createIntegration(context, keyProvider, {
        vendor: "mock",
        name: "Demo data",
        credentials: new Secret({ seed: "demo" }),
        actorUserId: null,
      }),
    );
    await syncIntegration(deps(T0), { tenantId, integrationId: integration.id });

    const clients = await db.withTenant(tenantId, ({ tx }) =>
      tx.client.findMany({ where: { name: "Harborview Dental Group" }, include: { assets: true } }),
    );
    expect(clients).toHaveLength(1);
    expect(clients[0]!.id).toBe(existing.id);
    expect(clients[0]!.assets.length).toBeGreaterThan(0);
  });
});

describe("syncIntegration: failures", () => {
  it("records a vendor rejection on the integration and stores no data", async () => {
    const target = await newTenant({ seed: "demo", simulate: "auth_error" });
    await expect(syncIntegration(deps(T0), target)).rejects.toBeInstanceOf(AuthError);

    const integration = await db.withTenant(target.tenantId, ({ tx }) =>
      tx.integration.findUniqueOrThrow({ where: { id: target.integrationId } }),
    );
    expect(integration).toMatchObject({
      syncStatus: "error",
      lastSyncAt: null,
      lastSyncStartedAt: T0,
      lastSyncError: "The vendor rejected these credentials. Check the keys and their permissions.",
    });
    expect(await counts(target.tenantId)).toEqual({
      clients: 0,
      mappings: 0,
      assets: 0,
      results: 0,
    });
  });

  it("a failure after a good sync keeps the previous data and the last good sync time", async () => {
    const target = await newTenant();
    await syncIntegration(deps(T0), target);
    const before = await counts(target.tenantId);

    const failing: SyncDeps["connectorFactory"] = () =>
      new MockConnector({ seed: "demo", simulate: "outage" });
    await expect(
      syncIntegration(deps(after(HOUR), { connectorFactory: failing }), target),
    ).rejects.toThrow();

    expect(await counts(target.tenantId)).toEqual(before);
    const integration = await db.withTenant(target.tenantId, ({ tx }) =>
      tx.integration.findUniqueOrThrow({ where: { id: target.integrationId } }),
    );
    expect(integration).toMatchObject({
      syncStatus: "error",
      lastSyncAt: T0,
      lastSyncError: "The vendor API could not be reached.",
    });

    // And it recovers on the next good sync.
    await syncIntegration(deps(after(2 * HOUR)), target);
    const recovered = await db.withTenant(target.tenantId, ({ tx }) =>
      tx.integration.findUniqueOrThrow({ where: { id: target.integrationId } }),
    );
    expect(recovered).toMatchObject({ syncStatus: "ok", lastSyncError: null });
  });

  it("a failure half-way through writing leaves nothing behind", async () => {
    const target = await newTenant();
    const broken: SyncDeps["connectorFactory"] = (vendor, credentials, connectorDeps) => {
      const real = createConnector(vendor, credentials, connectorDeps);
      return {
        vendor: real.vendor,
        testConnection: () => real.testConnection(),
        listClients: () => real.listClients(),
        listAssets: (id) => real.listAssets(id),
        listResults: (since) => real.listResults(since),
        // Throws while results are being written, after clients and assets.
        normalizeStatus: () => {
          throw new Error("normalizer exploded");
        },
      };
    };
    await expect(syncIntegration(deps(T0, { connectorFactory: broken }), target)).rejects.toThrow(
      "normalizer exploded",
    );
    expect(await counts(target.tenantId)).toEqual({
      clients: 0,
      mappings: 0,
      assets: 0,
      results: 0,
    });
    const integration = await db.withTenant(target.tenantId, ({ tx }) =>
      tx.integration.findUniqueOrThrow({ where: { id: target.integrationId } }),
    );
    expect(integration.lastSyncError).toBe("The sync failed unexpectedly. It will be retried.");
  });

  it("reports unreadable credentials without revealing why", async () => {
    const target = await newTenant();
    const otherKey = new LocalKeyProvider(randomBytes(32).toString("base64"));
    await expect(syncIntegration(deps(T0, { keyProvider: otherKey }), target)).rejects.toThrow(
      "The value could not be decrypted.",
    );
    const integration = await db.withTenant(target.tenantId, ({ tx }) =>
      tx.integration.findUniqueOrThrow({ where: { id: target.integrationId } }),
    );
    expect(integration.lastSyncError).toBe(
      "The saved credentials could not be read. Enter them again.",
    );
  });

  it("refuses the demo vendor where it is switched off", async () => {
    const target = await newTenant();
    await expect(syncIntegration(deps(T0, { allowMock: false }), target)).rejects.toThrow(
      /switched off/,
    );
  });

  it("only ever stores messages we wrote", () => {
    expect(describeFailure(new AuthError(401))).toMatch(/rejected these credentials/);
    expect(
      describeFailure(new Error("connect ECONNREFUSED postgresql://app:pw@10.0.0.4:5432")),
    ).toBe("The sync failed unexpectedly. It will be retried.");
    expect(describeFailure("a string")).toBe("The sync failed unexpectedly. It will be retried.");
  });
});

describe("syncIntegration: tenants", () => {
  it("cannot sync another tenant's integration", async () => {
    const mine = await newTenant();
    const theirs = await newTenant();
    await expect(
      syncIntegration(deps(T0), { tenantId: mine.tenantId, integrationId: theirs.integrationId }),
    ).rejects.toBeInstanceOf(IntegrationNotFoundError);

    const untouched = await db.withTenant(theirs.tenantId, ({ tx }) =>
      tx.integration.findUniqueOrThrow({ where: { id: theirs.integrationId } }),
    );
    expect(untouched).toMatchObject({ syncStatus: "never", lastSyncStartedAt: null });
  });

  it("two tenants with identical vendor data stay completely separate", async () => {
    const one = await newTenant();
    const two = await newTenant();
    await syncIntegration(deps(T0), one);
    await syncIntegration(deps(T0), two);

    const [a, b] = await Promise.all([counts(one.tenantId), counts(two.tenantId)]);
    expect(a).toEqual(b);
    expect(a.assets).toBeGreaterThan(0);

    const idsOf = (tenantId: string) =>
      db.withTenant(
        tenantId,
        async ({ tx }) => new Set((await tx.asset.findMany()).map((x) => x.id)),
      );
    const [idsA, idsB] = await Promise.all([idsOf(one.tenantId), idsOf(two.tenantId)]);
    for (const id of idsA) expect(idsB.has(id)).toBe(false);
  });
});

describe("syncIntegration: what reaches the log and the database", () => {
  it("stores credentials only as an encrypted envelope", async () => {
    const target = await newTenant({ seed: "fixture-seed-value-7f3a" });
    const row = await db.withTenant(target.tenantId, ({ tx }) =>
      tx.integration.findUniqueOrThrow({ where: { id: target.integrationId } }),
    );
    const stored = JSON.stringify(row.credentialsEnc);
    expect(stored).not.toContain("fixture-seed-value-7f3a");
    expect(row.credentialsEnc).toMatchObject({ v: 1, alg: "AES-256-GCM" });
  });

  it("records the integration's creation in the audit log, without credentials", async () => {
    const target = await newTenant({ seed: "fixture-seed-value-9c1d" });
    const entries = await db.withTenant(target.tenantId, ({ tx }) => tx.auditLog.findMany());
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: "integration.created",
      actorType: "system",
      targetType: "integration",
      targetId: target.integrationId,
      metadata: { vendor: "mock", name: "Demo data" },
    });
    expect(JSON.stringify(entries)).not.toContain("fixture-seed-value-9c1d");
  });

  it("logs no credentials and no vendor payloads", async () => {
    const target = await newTenant({ seed: "fixture-seed-value-2b8e" });
    logLines.length = 0;
    await syncIntegration(deps(T0), target);
    await syncIntegration(
      deps(after(HOUR), { keyProvider: new LocalKeyProvider(randomBytes(32).toString("base64")) }),
      target,
    ).catch(() => undefined);

    const output = logLines.join("");
    expect(output).toContain("sync finished");
    expect(output).toContain("sync failed");
    expect(output).not.toContain("fixture-seed-value-2b8e");
    expect(output).not.toContain("jobId");
    expect(output).not.toContain("ciphertext");
  });
});
