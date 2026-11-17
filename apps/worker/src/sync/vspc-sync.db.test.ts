import { randomBytes, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { vspcCredentialHint, type VspcCredentials } from "@valtrexia/connectors";
import { fakeVspc, FIXTURE_KEY, vspcFixture } from "@valtrexia/connectors/vspc/fixtures";
import { createLogger, LocalKeyProvider, Secret } from "@valtrexia/core/server";
import { createDb, createIntegration, type Db } from "@valtrexia/db";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { syncIntegration, type SyncDeps } from "./sync-integration";

// The whole path for a Veeam Service Provider Console integration: encrypted
// address and key in Postgres, the real connector over a stand-in console
// built to Veeam's published OpenAPI specification, and the sync pipeline.

const urls = inject("databaseUrls");
const HOUR = 3_600_000;
const NOW = new Date("2026-11-12T12:00:00Z");
const credentials: VspcCredentials = {
  serverUrl: "https://vspc.example.com:1280",
  apiKey: FIXTURE_KEY,
};
const keyProvider = new LocalKeyProvider(randomBytes(32).toString("base64"));

let db: Db;
const logLines: string[] = [];
const logger = createLogger({
  name: "vspc-sync-test",
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

async function vspcTenant() {
  const tenantId = await db.provisionTenant({
    clerkOrgId: `org_${randomUUID()}`,
    name: "Veeam MSP",
  });
  const integration = await db.withTenant(tenantId, (context) =>
    createIntegration(context, keyProvider, {
      vendor: "veeam_vspc",
      name: "VSPC",
      credentials: new Secret(credentials),
      credentialHint: vspcCredentialHint(credentials),
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

describe("syncing a VSPC integration", () => {
  it("turns companies into clients, VMs and agent computers into assets, and sessions into results", async () => {
    const target = await vspcTenant();
    const summary = await syncIntegration(deps(NOW, fakeVspc().fetch), target);
    expect(summary).toMatchObject({ clients: 2, assets: 6, resultsCreated: 6, resultsSkipped: 2 });

    const clients = await db.withTenant(target.tenantId, ({ tx }) =>
      tx.client.findMany({ orderBy: { name: "asc" } }),
    );
    expect(clients.map((c) => c.name)).toEqual(["Acme Dental", "Birch Law"]);

    const assets = await assetsByName(target.tenantId);
    expect(Object.keys(assets).sort()).toEqual(
      ["ACME-APP01", "ACME-FS01", "ACME-NEW01", "ACME-SQL01", "BIRCH-DC01", "BIRCH-LT-07"].sort(),
    );
    expect(assets["ACME-SQL01"]).toMatchObject({
      type: "vm",
      deviceName: "Acme nightly",
      expectedFrequencyHours: 24,
      lastResultStatus: "failed",
      currentStatus: "failed",
      client: { name: "Acme Dental" },
    });
    expect(assets["ACME-FS01"]).toMatchObject({ currentStatus: "warning" });
    expect(assets["BIRCH-DC01"]).toMatchObject({ currentStatus: "running", isPaused: true });
    expect(assets["BIRCH-LT-07"]).toMatchObject({ type: "agent", currentStatus: "failed" });
    // Never run: it has its grace window before it can be missed.
    expect(assets["ACME-NEW01"]).toMatchObject({ currentStatus: "unknown", lastResultAt: null });
  });

  it("stores each session normalized, with the vendor's status and record", async () => {
    const target = await vspcTenant();
    await syncIntegration(deps(NOW, fakeVspc().fetch), target);
    const laptop = await db.withTenant(target.tenantId, ({ tx }) =>
      tx.backupResult.findFirstOrThrow({ where: { asset: { name: "BIRCH-LT-07" } } }),
    );
    expect(laptop).toMatchObject({
      status: "failed",
      vendorStatusRaw: "Failed",
      message: "Unable to connect to the backup repository. The network path was not found.",
      startedAt: new Date("2026-11-12T09:00:00Z"),
      endedAt: new Date("2026-11-12T09:02:00Z"),
    });
    expect(laptop.rawPayload).toMatchObject({ backupAgentUid: expect.any(String) as string });
  });

  it("opens incidents for failures, and builds history across syncs", async () => {
    const target = await vspcTenant();
    const fixture = vspcFixture();
    await syncIntegration(deps(NOW, fakeVspc(fixture).fetch), target);
    const open = () =>
      db.withTenant(target.tenantId, async ({ tx }) =>
        (await tx.incident.findMany({ where: { closedAt: null }, include: { asset: true } }))
          .map((i) => `${i.asset.name}:${i.type}`)
          .sort(),
      );
    // ACME-SQL01's last good backup was the weekly job's, on 8 November: 86
    // hours ago, so it is also missed and past its 72-hour SLA.
    expect(await open()).toEqual([
      "ACME-SQL01:failed",
      "ACME-SQL01:missed",
      "ACME-SQL01:stale",
      "BIRCH-LT-07:failed",
    ]);

    // The next night the SQL job succeeds. A new session, a new result; all
    // three incidents close, and the failed result is kept as history.
    const sql = fixture.vmObjects[0] as { lastSession: Record<string, unknown> };
    sql.lastSession = {
      ...sql.lastSession,
      backupStatus: "Success",
      startTime: "2026-11-13T01:00:00+00:00",
      endTime: "2026-11-13T01:15:00+00:00",
      messages: [],
    };
    const next = await syncIntegration(
      deps(new Date(NOW.getTime() + 15 * HOUR), fakeVspc(fixture).fetch),
      target,
    );
    expect(next).toMatchObject({ resultsCreated: 1, resultsUpdated: 0, incidentsClosed: 3 });
    // Meanwhile ACME-APP01's last good backup (23:00 on the 11th) is now 28
    // hours old: past its 24-hour schedule and 2 hours of grace.
    expect(await open()).toEqual(["ACME-APP01:missed", "BIRCH-LT-07:failed"]);
    const sqlResults = await db.withTenant(target.tenantId, ({ tx }) =>
      tx.backupResult.findMany({
        where: { asset: { name: "ACME-SQL01" } },
        orderBy: { startedAt: "asc" },
      }),
    );
    expect(sqlResults.map((r) => r.status)).toEqual(["success", "failed", "success"]);
  });

  it("is idempotent: the same sessions twice change nothing", async () => {
    const target = await vspcTenant();
    await syncIntegration(deps(NOW, fakeVspc().fetch), target);
    expect(await syncIntegration(deps(NOW, fakeVspc().fetch), target)).toMatchObject({
      resultsCreated: 0,
      resultsUpdated: 0,
      incidentsOpened: 0,
    });
  });

  it("completes a session that was running on the last sync", async () => {
    const target = await vspcTenant();
    const fixture = vspcFixture();
    await syncIntegration(deps(NOW, fakeVspc(fixture).fetch), target);
    const dc = fixture.vmObjects.find((o) => o.name === "BIRCH-DC01") as {
      lastSession: Record<string, unknown>;
    };
    dc.lastSession = {
      ...dc.lastSession,
      backupStatus: "Success",
      endTime: "2026-11-12T12:10:00+00:00",
    };
    const next = await syncIntegration(
      deps(new Date(NOW.getTime() + HOUR), fakeVspc(fixture).fetch),
      target,
    );
    expect(next).toMatchObject({ resultsCreated: 0, resultsUpdated: 1 });
    expect((await assetsByName(target.tenantId))["BIRCH-DC01"]).toMatchObject({
      currentStatus: "success",
    });
  });

  it("records a rejected key as needing action, and stores nothing", async () => {
    const target = await vspcTenant();
    const rejecting = fakeVspc(vspcFixture(), { key: "some-other-key-0000000000" });
    await expect(syncIntegration(deps(NOW, rejecting.fetch), target)).rejects.toThrow();
    const integration = await db.withTenant(target.tenantId, ({ tx }) =>
      tx.integration.findUniqueOrThrow({ where: { id: target.integrationId } }),
    );
    expect(integration).toMatchObject({ syncStatus: "error", lastSyncErrorKind: "auth" });
    expect(await db.withTenant(target.tenantId, ({ tx }) => tx.asset.count())).toBe(0);
  });

  it("refuses a console at a private address, says why, and never connects", async () => {
    const tenantId = await db.provisionTenant({ clerkOrgId: `org_${randomUUID()}`, name: "MSP" });
    const internal = { serverUrl: "https://192.168.1.20:1280", apiKey: FIXTURE_KEY };
    const integration = await db.withTenant(tenantId, (context) =>
      createIntegration(context, keyProvider, {
        vendor: "veeam_vspc",
        name: "Internal VSPC",
        credentials: new Secret(internal),
        actorUserId: null,
      }),
    );
    // No fetch override: the real guarded fetch is used.
    await expect(
      syncIntegration(
        { db, keyProvider, logger, allowMock: false, now: () => NOW },
        { tenantId, integrationId: integration.id },
      ),
    ).rejects.toThrow("The URL must point to a public address, not a private or internal one.");
    const row = await db.withTenant(tenantId, ({ tx }) =>
      tx.integration.findUniqueOrThrow({ where: { id: integration.id } }),
    );
    expect(row).toMatchObject({
      lastSyncError: "The URL must point to a public address, not a private or internal one.",
      lastSyncErrorKind: "credentials",
      unhealthySince: NOW,
    });
  });

  it("writes neither the key, nor an owner's password, nor any payload to the log", async () => {
    const target = await vspcTenant();
    logLines.length = 0;
    await syncIntegration(deps(NOW, fakeVspc().fetch), target);
    const log = logLines.join("\n");
    expect(log).toContain("sync finished");
    for (const secret of [
      FIXTURE_KEY,
      "company-owner-password-must-not-leak",
      "Snapshot timed out",
    ]) {
      expect(log).not.toContain(secret);
    }
    // And no stored record holds an owner's password either.
    const stored = await db.withTenant(target.tenantId, ({ tx }) => tx.backupResult.findMany());
    expect(JSON.stringify(stored)).not.toContain("company-owner-password-must-not-leak");
  });
});
