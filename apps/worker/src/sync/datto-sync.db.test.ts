import { randomBytes, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { AuthError, dattoCredentialHint } from "@valtrexia/connectors";
import { fakeDatto, FIXTURE_NOW, fixtureAssets } from "@valtrexia/connectors/datto/fixtures";
import { compareWorstFirst, summarizeClientHealth } from "@valtrexia/core";
import { createLogger, LocalKeyProvider, Secret } from "@valtrexia/core/server";
import { createDb, createIntegration, type Db } from "@valtrexia/db";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { syncIntegration, type SyncDeps } from "./sync-integration";

// The whole path for a Datto integration: encrypted keys in Postgres, the
// real connector over a stand-in for Datto's API, the sync pipeline, and the
// statuses a technician would see. The API responses are assumed shapes, not
// captures from a live account (see packages/connectors/src/datto/schema.ts).

const urls = inject("databaseUrls");
const HOUR = 3_600_000;
const credentials = { publicKey: "fixture-public-9f3a", secretKey: "fixture-secret-do-not-use" };
const keyProvider = new LocalKeyProvider(randomBytes(32).toString("base64"));

let db: Db;
const logLines: string[] = [];
const logger = createLogger({
  name: "datto-sync-test",
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

function deps(now: Date, fetchImpl: typeof fetch): SyncDeps {
  return { db, keyProvider, logger, allowMock: false, now: () => now, fetch: fetchImpl };
}

async function dattoTenant(keys = credentials) {
  const tenantId = await db.provisionTenant({
    clerkOrgId: `org_${randomUUID()}`,
    name: "Datto MSP",
  });
  const integration = await db.withTenant(tenantId, (context) =>
    createIntegration(context, keyProvider, {
      vendor: "datto_bcdr",
      name: "Datto BCDR",
      credentials: new Secret(keys),
      credentialHint: dattoCredentialHint(keys.publicKey),
      actorUserId: null,
    }),
  );
  return { tenantId, integrationId: integration.id };
}

const assetsByName = async (tenantId: string) =>
  Object.fromEntries(
    (await db.withTenant(tenantId, ({ tx }) => tx.asset.findMany())).map((a) => [a.name, a]),
  );

describe("syncing a Datto integration", () => {
  it("uses the stored keys and turns Datto's devices into clients, assets and results", async () => {
    const target = await dattoTenant();
    const api = fakeDatto({ accept: credentials });
    const summary = await syncIntegration(deps(FIXTURE_NOW, api.fetch), target);

    expect(summary).toMatchObject({
      clients: 3,
      assets: 8,
      resultsFetched: 9,
      resultsCreated: 9,
      resultsSkipped: 0,
    });
    expect(new Set(api.calls.map((c) => c.method))).toEqual(new Set(["GET"]));

    const clients = await db.withTenant(target.tenantId, ({ tx }) =>
      tx.client.findMany({ orderBy: { name: "asc" }, include: { assets: true } }),
    );
    expect(clients.map((c) => [c.name, c.assets.length])).toEqual([
      ["Harborview Dental Group", 4],
      ["Kestrel Freight & Logistics", 4],
      ["Spare unit", 0],
    ]);
  });

  it("gives each asset the status a technician should see", async () => {
    const target = await dattoTenant();
    await syncIntegration(deps(FIXTURE_NOW, fakeDatto().fetch), target);
    const assets = await assetsByName(target.tenantId);

    expect(
      Object.fromEntries(Object.entries(assets).map(([name, a]) => [name, a.currentStatus])),
    ).toEqual({
      "HDG-DC01": "success", // latest backup and its screenshot both fine
      "HDG-FS01": "failed", // latest backup failed
      Scans: "success", // a share: no screenshot to verify
      "HDG-SQL01": "warning", // backed up, but local verification found an error
      "KFL-APP01": "success", // paused: not judged, shows its last result
      "KFL-OLD01": "unknown", // archived, no backups
      "KFL-DB01": "unknown", // a status string we cannot interpret
      "KFL-NEW01": "unknown", // discovered just now, never backed up
    });
    expect(assets["HDG-DC01"]).toMatchObject({
      type: "agent",
      deviceName: "HDG-BDR01",
      isPaused: false,
    });
    expect(assets["HDG-SQL01"]).toMatchObject({ deviceName: "HDG-BDR02" });
    expect(assets.Scans).toMatchObject({ type: "share" });
    expect(assets["KFL-APP01"]).toMatchObject({ isPaused: true });
    expect(assets["KFL-OLD01"]).toMatchObject({ isArchived: true });
    // Datto does not report a schedule, so the default applies.
    expect(assets["HDG-DC01"]!.expectedFrequencyHours).toBe(24);
  });

  it("stores each backup normalized, with screenshot verification and Datto's record", async () => {
    const target = await dattoTenant();
    await syncIntegration(deps(FIXTURE_NOW, fakeDatto().fetch), target);
    const results = await db.withTenant(target.tenantId, ({ tx }) =>
      tx.backupResult.findMany({ include: { asset: true }, orderBy: { startedAt: "asc" } }),
    );

    const dc01 = results.filter((r) => r.asset.name === "HDG-DC01");
    expect(dc01.map((r) => [r.status, r.screenshotVerified])).toEqual([
      ["success", true],
      ["warning", false],
      ["success", true],
    ]);
    expect(dc01[1]).toMatchObject({
      vendorStatusRaw: "success",
      message: "Screenshot verification failed.",
      rawPayload: {
        backup: { status: "success" },
        advancedVerification: { screenshotVerification: { status: "failure" } },
      },
    });

    const failed = results.find((r) => r.status === "failed")!;
    expect(failed).toMatchObject({
      vendorStatusRaw: "failure",
      message: "Unable to take a VSS snapshot of volume D:",
      screenshotVerified: null,
    });
    expect(results.find((r) => r.asset.name === "Scans")!.screenshotVerified).toBeNull();
    expect(results.find((r) => r.asset.name === "KFL-DB01")).toMatchObject({
      status: "unknown",
      vendorStatusRaw: "verifying",
    });
  });

  it("rolls up to red, amber and none, worst first", async () => {
    const target = await dattoTenant();
    await syncIntegration(deps(FIXTURE_NOW, fakeDatto().fetch), target);
    const clients = await db.withTenant(target.tenantId, ({ tx }) =>
      tx.client.findMany({ include: { assets: true } }),
    );
    const ranked = clients
      .map((c) => ({
        name: c.name,
        summary: summarizeClientHealth(c.assets, { now: FIXTURE_NOW }),
      }))
      .sort(compareWorstFirst);

    expect(ranked.map((c) => [c.name, c.summary.health, c.summary.affected])).toEqual([
      ["Harborview Dental Group", "red", 1],
      ["Kestrel Freight & Logistics", "amber", 2],
      ["Spare unit", "none", 0],
    ]);
  });

  it("flags missed backups once Datto stops reporting new ones", async () => {
    const target = await dattoTenant();
    await syncIntegration(deps(FIXTURE_NOW, fakeDatto().fetch), target);
    // Thirty hours later, Datto still lists the same backups and nothing new.
    const later = new Date(FIXTURE_NOW.getTime() + 30 * HOUR);
    const summary = await syncIntegration(deps(later, fakeDatto().fetch), target);
    const assets = await assetsByName(target.tenantId);

    expect(summary.resultsCreated).toBe(0);
    expect(
      Object.fromEntries(Object.entries(assets).map(([name, a]) => [name, a.currentStatus])),
    ).toEqual({
      "HDG-DC01": "missed",
      "HDG-FS01": "failed", // still failed, which outranks missed
      Scans: "missed",
      "HDG-SQL01": "missed",
      "KFL-APP01": "success", // paused: never judged
      "KFL-OLD01": "unknown", // archived: never judged
      "KFL-DB01": "missed", // nothing completed since it was first seen
      "KFL-NEW01": "missed", // never backed up, and the grace window has passed
    });
    // What Datto last said is kept alongside the derived status.
    expect(assets["HDG-SQL01"]!.lastResultStatus).toBe("warning");
    expect(assets["KFL-NEW01"]!.lastResultStatus).toBeNull();
  });

  it("is idempotent, and picks up a new backup on the next sync", async () => {
    const target = await dattoTenant();
    await syncIntegration(deps(FIXTURE_NOW, fakeDatto().fetch), target);
    const again = await syncIntegration(deps(FIXTURE_NOW, fakeDatto().fetch), target);
    expect(again).toMatchObject({ resultsCreated: 0, resultsUpdated: 0 });

    // FS01 backs up successfully an hour later.
    const assets = structuredClone(fixtureAssets);
    const fs01 = assets.A1B2C3D4E5F6![1] as { backups: unknown[] };
    fs01.backups.push({
      timestamp: Math.floor((FIXTURE_NOW.getTime() + HOUR) / 1000),
      backup: { status: "success", errorMessage: null },
    });
    const later = new Date(FIXTURE_NOW.getTime() + 2 * HOUR);
    const summary = await syncIntegration(deps(later, fakeDatto({ assets }).fetch), target);

    expect(summary.resultsCreated).toBe(1);
    expect((await assetsByName(target.tenantId))["HDG-FS01"]!.currentStatus).toBe("success");
  });

  it("records rejected keys on the integration and stores nothing", async () => {
    const target = await dattoTenant({
      publicKey: "fixture-public-9f3a",
      secretKey: "fixture-revoked",
    });
    const api = fakeDatto({ accept: credentials });
    await expect(syncIntegration(deps(FIXTURE_NOW, api.fetch), target)).rejects.toBeInstanceOf(
      AuthError,
    );

    const integration = await db.withTenant(target.tenantId, ({ tx }) =>
      tx.integration.findUniqueOrThrow({ where: { id: target.integrationId } }),
    );
    expect(integration).toMatchObject({
      syncStatus: "error",
      lastSyncAt: null,
      lastSyncError: "The vendor rejected these credentials. Check the keys and their permissions.",
    });
    expect(await db.withTenant(target.tenantId, ({ tx }) => tx.asset.count())).toBe(0);
  });

  it("an outage part-way through leaves the previous data and marks the sync as failing", async () => {
    const target = await dattoTenant();
    await syncIntegration(deps(FIXTURE_NOW, fakeDatto().fetch), target);
    const before = await assetsByName(target.tenantId);

    const broken = fakeDatto({
      override: (path) =>
        path.endsWith("FFEEDDCCBBAA/asset") ? new Response("", { status: 500 }) : undefined,
    });
    const later = new Date(FIXTURE_NOW.getTime() + 30 * HOUR);
    await expect(syncIntegration(deps(later, broken.fetch), target)).rejects.toThrow();

    // Nothing was flagged as missed on the strength of a failed sync.
    const after = await assetsByName(target.tenantId);
    for (const [name, asset] of Object.entries(after)) {
      expect(asset.currentStatus, name).toBe(before[name]!.currentStatus);
    }
    const integration = await db.withTenant(target.tenantId, ({ tx }) =>
      tx.integration.findUniqueOrThrow({ where: { id: target.integrationId } }),
    );
    expect(integration).toMatchObject({ syncStatus: "error", lastSyncAt: FIXTURE_NOW });
  }, 60_000);

  it("writes nothing from the keys or Datto's payloads to the log", async () => {
    const target = await dattoTenant();
    logLines.length = 0;
    await syncIntegration(deps(FIXTURE_NOW, fakeDatto().fetch), target);
    const output = logLines.join("");

    expect(output).toContain("sync finished");
    expect(output).toContain("/v1/bcdr/device");
    for (const secret of [
      credentials.secretKey,
      credentials.publicKey,
      Buffer.from(`${credentials.publicKey}:${credentials.secretKey}`).toString("base64"),
      "Unable to take a VSS snapshot",
      "screenshotVerification",
    ]) {
      expect(output, `log must not contain ${secret}`).not.toContain(secret);
    }
  });
});
