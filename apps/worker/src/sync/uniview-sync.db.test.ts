import { randomBytes, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { univiewCredentialHint, type UniviewCredentials } from "@valtrexia/connectors";
import {
  fakeUniview,
  FIXTURE_CLIENT_ID,
  FIXTURE_CLIENT_SECRET,
  FIXTURE_TOKEN,
  univiewFixture,
} from "@valtrexia/connectors/uniview/fixtures";
import { createLogger, LocalKeyProvider, Secret } from "@valtrexia/core/server";
import { createDb, createIntegration, type Db } from "@valtrexia/db";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { syncIntegration, type SyncDeps } from "./sync-integration";

// The whole path for a Kaseya UniView integration: an encrypted client ID
// and secret in Postgres, the real connector over a stand-in UniView built to
// Kaseya's published OpenAPI specification, and the sync pipeline.

const urls = inject("databaseUrls");
const HOUR = 3_600_000;
const NOW = new Date("2026-11-12T12:00:00Z");
const credentials: UniviewCredentials = {
  clientId: FIXTURE_CLIENT_ID,
  clientSecret: FIXTURE_CLIENT_SECRET,
};
const keyProvider = new LocalKeyProvider(randomBytes(32).toString("base64"));

let db: Db;
const logLines: string[] = [];
const logger = createLogger({
  name: "uniview-sync-test",
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

const deps = (now: Date, fetchImpl: typeof fetch): SyncDeps => ({
  db,
  keyProvider,
  logger,
  allowMock: false,
  now: () => now,
  fetch: fetchImpl,
});

async function univiewTenant() {
  const tenantId = await db.provisionTenant({
    clerkOrgId: `org_${randomUUID()}`,
    name: "Unitrends MSP",
  });
  const integration = await db.withTenant(tenantId, (context) =>
    createIntegration(context, keyProvider, {
      vendor: "kaseya_uniview",
      name: "UniView",
      credentials: new Secret(credentials),
      credentialHint: univiewCredentialHint(credentials),
      actorUserId: null,
    }),
  );
  return { tenantId, integrationId: integration.id };
}

const assetsByName = async (tenantId: string) =>
  Object.fromEntries(
    (
      await db.withTenant(tenantId, ({ tx }) => tx.asset.findMany({ include: { client: true } }))
    ).map((a) => [a.name, a]),
  );

const openIncidents = (tenantId: string) =>
  db.withTenant(tenantId, async ({ tx }) =>
    (await tx.incident.findMany({ where: { closedAt: null }, include: { asset: true } }))
      .map((i) => `${i.asset.name}:${i.type}`)
      .sort(),
  );

describe("syncing a UniView integration", () => {
  it("turns customers into clients, protected assets into assets, and backups into results", async () => {
    const target = await univiewTenant();
    const summary = await syncIntegration(deps(NOW, fakeUniview().fetch), target);
    expect(summary).toMatchObject({ clients: 2, assets: 4, resultsCreated: 4, resultsSkipped: 0 });

    const clients = await db.withTenant(target.tenantId, ({ tx }) =>
      tx.client.findMany({ orderBy: { name: "asc" } }),
    );
    expect(clients.map((c) => c.name)).toEqual(["Acme Dental", "Birch Law"]);

    const assets = await assetsByName(target.tenantId);
    expect(Object.keys(assets).sort()).toEqual(
      ["ACME-FS01", "ACME-NEW01", "ACME-SQL01", "BIRCH-DC01"].sort(),
    );
    expect(assets["ACME-SQL01"]).toMatchObject({
      type: "windows",
      deviceName: "acme-ueb",
      // UniView does not report schedules: the default stands until someone changes it.
      expectedFrequencyHours: 24,
      lastResultStatus: "failed",
      currentStatus: "failed",
      lastSuccessAt: new Date("2026-11-10T01:20:00Z"),
      client: { name: "Acme Dental" },
    });
    expect(assets["ACME-FS01"]).toMatchObject({ type: "vmware", currentStatus: "warning" });
    expect(assets["BIRCH-DC01"]).toMatchObject({
      deviceName: "birch-recovery-936",
      currentStatus: "running",
      isPaused: false,
    });
    // Never backed up: it has its grace window before it can be missed.
    expect(assets["ACME-NEW01"]).toMatchObject({ currentStatus: "unknown", lastResultAt: null });
  });

  it("stores each backup normalized, with the vendor's status and record", async () => {
    const target = await univiewTenant();
    await syncIntegration(deps(NOW, fakeUniview().fetch), target);
    const fs = await db.withTenant(target.tenantId, ({ tx }) =>
      tx.backupResult.findFirstOrThrow({ where: { asset: { name: "ACME-FS01" } } }),
    );
    expect(fs).toMatchObject({
      status: "warning",
      vendorStatusRaw: "Warning",
      message: "Incremental backup. Replication to the target failed.",
      startedAt: new Date("2026-11-12T01:05:00Z"),
      endedAt: new Date("2026-11-12T01:30:00Z"),
      screenshotVerified: null,
    });
    expect(fs.rawPayload).toMatchObject({ replication_status: "Failed", size: 1_048_576 });
  });

  it("opens incidents for failures, and builds history across syncs", async () => {
    const target = await univiewTenant();
    const fixture = univiewFixture();
    await syncIntegration(deps(NOW, fakeUniview(fixture).fetch), target);
    // ACME-SQL01's last good backup finished at 01:20 on the 10th: 58 hours
    // ago, past its 24-hour default and 2 hours of grace.
    expect(await openIncidents(target.tenantId)).toEqual([
      "ACME-SQL01:failed",
      "ACME-SQL01:missed",
    ]);

    // The next night it succeeds: a new backup, a new result, both incidents
    // close, and the failure is kept as history.
    fixture.backups.push({
      ...fixture.backups[1]!,
      status: "Successful",
      start_time: "2026-11-13T01:00:00Z",
      complete_time: "2026-11-13T01:15:00Z",
    });
    const next = await syncIntegration(
      deps(new Date(NOW.getTime() + 15 * HOUR), fakeUniview(fixture).fetch),
      target,
    );
    expect(next).toMatchObject({ resultsCreated: 1, incidentsClosed: 2 });
    const sqlResults = await db.withTenant(target.tenantId, ({ tx }) =>
      tx.backupResult.findMany({
        where: { asset: { name: "ACME-SQL01" } },
        orderBy: { startedAt: "asc" },
      }),
    );
    expect(sqlResults.map((r) => r.status)).toEqual(["success", "failed", "success"]);
  });

  it("is idempotent: the same backups twice change nothing", async () => {
    const target = await univiewTenant();
    await syncIntegration(deps(NOW, fakeUniview().fetch), target);
    expect(await syncIntegration(deps(NOW, fakeUniview().fetch), target)).toMatchObject({
      resultsCreated: 0,
      resultsUpdated: 0,
      incidentsOpened: 0,
    });
  });

  it("completes a backup that was running on the last sync, as the same result", async () => {
    const target = await univiewTenant();
    const fixture = univiewFixture();
    await syncIntegration(deps(NOW, fakeUniview(fixture).fetch), target);
    const dc = fixture.backups[3]!;
    dc.status = "Successful";
    dc.complete_time = "2026-11-12T12:10:00Z";
    const next = await syncIntegration(
      deps(new Date(NOW.getTime() + HOUR), fakeUniview(fixture).fetch),
      target,
    );
    expect(next).toMatchObject({ resultsCreated: 0, resultsUpdated: 1 });
    expect((await assetsByName(target.tenantId))["BIRCH-DC01"]).toMatchObject({
      currentStatus: "success",
      lastSuccessAt: new Date("2026-11-12T12:10:00Z"),
    });
  });

  it("records a rejected client secret as needing action, and stores nothing", async () => {
    const target = await univiewTenant();
    const rejecting = fakeUniview(univiewFixture(), { clientSecret: "some-other-secret-00000" });
    await expect(syncIntegration(deps(NOW, rejecting.fetch), target)).rejects.toThrow();
    const integration = await db.withTenant(target.tenantId, ({ tx }) =>
      tx.integration.findUniqueOrThrow({ where: { id: target.integrationId } }),
    );
    expect(integration).toMatchObject({ syncStatus: "error", lastSyncErrorKind: "auth" });
    expect(await db.withTenant(target.tenantId, ({ tx }) => tx.asset.count())).toBe(0);
  });

  it("writes neither the secret, nor the token, nor any payload to the log", async () => {
    const target = await univiewTenant();
    logLines.length = 0;
    await syncIntegration(deps(NOW, fakeUniview().fetch), target);
    const log = logLines.join("\n");
    expect(log).toContain("sync finished");
    for (const secret of [FIXTURE_CLIENT_SECRET, FIXTURE_TOKEN, "Replication to the target"]) {
      expect(log).not.toContain(secret);
    }
  });
});
