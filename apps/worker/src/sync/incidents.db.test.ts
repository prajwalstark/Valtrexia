import { randomBytes, randomUUID } from "node:crypto";
import type { Connector, NormalizedStatus, VendorResult } from "@valtrexia/connectors";
import { createLogger, LocalKeyProvider, Secret } from "@valtrexia/core/server";
import { createDb, createIntegration, type Db } from "@valtrexia/db";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { syncIntegration, type SyncDeps } from "./sync-integration";

// Incident lifecycle through the real sync and a real Postgres, with a vendor
// whose every answer the test scripts.

const urls = inject("databaseUrls");
const HOUR = 3_600_000;
const T0 = new Date("2026-11-12T12:00:00Z");
const at = (hours: number) => new Date(T0.getTime() + hours * HOUR);

let db: Db;
const keyProvider = new LocalKeyProvider(randomBytes(32).toString("base64"));
const logger = createLogger({ name: "incident-test", level: "silent" });

beforeAll(() => {
  db = createDb({ url: urls.app });
});
afterAll(async () => {
  await db.disconnect();
});

/** A vendor with one client and whatever assets and results the test gives it. */
class ScriptedVendor {
  assets = new Map<string, { isPaused: boolean; isArchived: boolean }>();
  results: { asset: string; at: Date; status: NormalizedStatus }[] = [];
  down = false;

  asset(name: string, flags: Partial<{ isPaused: boolean; isArchived: boolean }> = {}) {
    this.assets.set(name, { isPaused: false, isArchived: false, ...flags });
    return this;
  }
  result(asset: string, when: Date, status: NormalizedStatus) {
    if (!this.assets.has(asset)) this.asset(asset);
    this.results.push({ asset, at: when, status });
    return this;
  }

  connector(): Connector {
    const fail = () => {
      if (this.down) throw new Error("vendor is down");
    };
    return {
      vendor: "mock",
      testConnection: async () => fail(),
      listClients: async () => (fail(), [{ vendorClientId: "c1", name: "Only Client" }]),
      listAssets: async () => (
        fail(),
        [...this.assets].map(([name, flags]) => ({
          vendorAssetId: name,
          vendorClientId: "c1",
          name,
          type: "agent",
          deviceName: null,
          expectedFrequencyHours: 24,
          ...flags,
        }))
      ),
      listResults: async (since) => (
        fail(),
        this.results
          .filter((r) => r.at.getTime() >= since.getTime())
          .map((r): VendorResult => ({
            vendorResultId: String(r.at.getTime()),
            vendorAssetId: r.asset,
            startedAt: r.at,
            endedAt: r.status === "running" ? null : r.at,
            vendorStatusRaw: r.status,
            message: null,
            screenshotVerified: null,
            rawPayload: { status: r.status },
          }))
      ),
      normalizeStatus: (raw) => (raw as { status: NormalizedStatus }).status,
    };
  }
}

async function setup(vendor: ScriptedVendor) {
  const tenantId = await db.provisionTenant({ clerkOrgId: `org_${randomUUID()}`, name: "MSP" });
  const integration = await db.withTenant(tenantId, (context) =>
    createIntegration(context, keyProvider, {
      vendor: "mock",
      name: "Scripted",
      credentials: new Secret({ seed: "unused" }),
      actorUserId: null,
    }),
  );
  const target = { tenantId, integrationId: integration.id };
  const sync = (now: Date) => {
    const deps: SyncDeps = {
      db,
      keyProvider,
      logger,
      allowMock: true,
      now: () => now,
      connectorFactory: () => vendor.connector(),
    };
    return syncIntegration(deps, target);
  };
  const incidents = (asset?: string) =>
    db.withTenant(tenantId, async ({ tx }) =>
      (
        await tx.incident.findMany({
          where: asset ? { asset: { name: asset } } : {},
          include: { asset: true },
          orderBy: [{ openedAt: "asc" }, { type: "asc" }],
        })
      ).map((i) => ({
        asset: i.asset.name,
        type: i.type,
        openedAt: i.openedAt,
        closedAt: i.closedAt,
        acknowledgedByUserId: i.acknowledgedByUserId,
        id: i.id,
      })),
    );
  const open = async (asset?: string) =>
    (await incidents(asset)).filter((i) => i.closedAt === null).map((i) => `${i.asset}:${i.type}`);
  return { tenantId, target, sync, incidents, open };
}

describe("incidents: failed backups", () => {
  it("opens one incident when a backup fails, and reports it in the sync summary", async () => {
    // Backed up 20 hours ago (so not overdue), then the latest attempt failed.
    const vendor = new ScriptedVendor()
      .result("DC01", at(-20), "success")
      .result("DC01", at(-1), "failed");
    const { sync, incidents } = await setup(vendor);
    const summary = await sync(T0);

    expect(summary).toMatchObject({ incidentsOpened: 1, incidentsClosed: 0 });
    expect(await incidents()).toMatchObject([
      { asset: "DC01", type: "failed", openedAt: T0, closedAt: null, acknowledgedByUserId: null },
    ]);
  });

  it("keeps the same incident open across repeated failures instead of opening more", async () => {
    const vendor = new ScriptedVendor().result("DC01", at(-1), "failed");
    const { sync, incidents } = await setup(vendor);
    await sync(T0);
    const [first] = await incidents();

    vendor.result("DC01", at(0.5), "failed");
    await sync(at(1));
    vendor.result("DC01", at(1.5), "failed");
    const third = await sync(at(2));

    expect(third).toMatchObject({ incidentsOpened: 0, incidentsClosed: 0 });
    const failed = (await incidents()).filter((i) => i.type === "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ id: first!.id, openedAt: T0, closedAt: null });
  });

  it("closes the incident when a backup completes, at the time of that sync", async () => {
    const vendor = new ScriptedVendor().result("DC01", at(-1), "failed");
    const { sync, incidents } = await setup(vendor);
    await sync(T0);

    vendor.result("DC01", at(2), "success");
    const summary = await sync(at(3));
    expect(summary).toMatchObject({ incidentsOpened: 0, incidentsClosed: 1 });
    expect(await incidents()).toMatchObject([{ type: "failed", openedAt: T0, closedAt: at(3) }]);
  });

  it("a warning also closes it: a backup was taken", async () => {
    const vendor = new ScriptedVendor().result("DC01", at(-1), "failed");
    const { sync, open } = await setup(vendor);
    await sync(T0);
    vendor.result("DC01", at(1), "warning");
    await sync(at(2));
    expect(await open()).toEqual([]);
  });

  it("stays open while a retry is running or its outcome is unreadable", async () => {
    const vendor = new ScriptedVendor().result("DC01", at(-1), "failed");
    const { sync, open } = await setup(vendor);
    await sync(T0);

    vendor.result("DC01", at(1), "running");
    await sync(at(1.25));
    expect(await open()).toEqual(["DC01:failed"]);

    vendor.result("DC01", at(2), "unknown");
    await sync(at(2.25));
    expect(await open()).toEqual(["DC01:failed"]);
  });

  it("opens a new incident for a new failure after the old one closed", async () => {
    const vendor = new ScriptedVendor().result("DC01", at(-1), "failed");
    const { sync, incidents } = await setup(vendor);
    await sync(T0);
    vendor.result("DC01", at(1), "success");
    await sync(at(2));
    vendor.result("DC01", at(3), "failed");
    await sync(at(4));

    expect(await incidents()).toMatchObject([
      { type: "failed", openedAt: T0, closedAt: at(2) },
      { type: "failed", openedAt: at(4), closedAt: null },
    ]);
  });
});

describe("incidents: missed backups", () => {
  it("opens when a backup is overdue and closes when one arrives", async () => {
    const vendor = new ScriptedVendor().result("FS01", at(-2), "success");
    const { sync, incidents, open } = await setup(vendor);
    await sync(T0);
    expect(await open()).toEqual([]);

    // 24 h frequency + 2 h grace after the last backup, and a little more.
    await sync(at(25));
    expect(await open()).toEqual(["FS01:missed"]);

    vendor.result("FS01", at(26), "success");
    await sync(at(27));
    expect(await incidents()).toMatchObject([
      { type: "missed", openedAt: at(25), closedAt: at(27) },
    ]);
  });

  it("opens for an asset that has never been backed up, once its grace window passes", async () => {
    const vendor = new ScriptedVendor().asset("NEW01");
    const { sync, open } = await setup(vendor);
    await sync(T0);
    await sync(at(25));
    expect(await open()).toEqual([]);
    await sync(at(27));
    expect(await open()).toEqual(["NEW01:missed"]);
  });

  it("raises both when backups keep failing: the attempt failed, and none completed in time", async () => {
    const vendor = new ScriptedVendor()
      .result("SQL01", at(-30), "success")
      .result("SQL01", at(-1), "failed");
    const { sync, open } = await setup(vendor);
    await sync(T0);
    expect((await open()).sort()).toEqual(["SQL01:failed", "SQL01:missed"]);

    vendor.result("SQL01", at(1), "success");
    await sync(at(2));
    expect(await open()).toEqual([]);
  });
});

describe("incidents: assets that stop being watched", () => {
  it("closes open incidents when an asset is paused or archived at the vendor", async () => {
    const vendor = new ScriptedVendor()
      .result("A", at(-40), "success")
      .result("A", at(-1), "failed")
      .result("B", at(-40), "success");
    const { sync, open } = await setup(vendor);
    await sync(T0);
    expect((await open()).sort()).toEqual(["A:failed", "A:missed", "B:missed"]);

    vendor.asset("A", { isPaused: true }).asset("B", { isArchived: true });
    const summary = await sync(at(1));
    expect(summary.incidentsClosed).toBe(3);
    expect(await open()).toEqual([]);
  });

  it("closes them when a technician mutes the asset, and reopens after the mute ends", async () => {
    const vendor = new ScriptedVendor().result("A", at(-40), "success");
    const { tenantId, sync, open, incidents } = await setup(vendor);
    await sync(T0);
    expect(await open()).toEqual(["A:missed"]);

    await db.withTenant(tenantId, ({ tx }) =>
      tx.asset.updateMany({ where: { name: "A" }, data: { mutedUntil: at(10) } }),
    );
    await sync(at(1));
    expect(await open()).toEqual([]);

    await sync(at(11));
    expect(await open()).toEqual(["A:missed"]);
    expect(await incidents()).toHaveLength(2);
  });
});

describe("incidents: when the vendor cannot be reached", () => {
  it("a failed sync neither opens nor closes anything", async () => {
    const vendor = new ScriptedVendor()
      .result("A", at(-1), "failed")
      .result("B", at(-2), "success");
    const { sync, incidents } = await setup(vendor);
    await sync(T0);
    const before = await incidents();
    expect(before.map((i) => `${i.asset}:${i.type}`)).toEqual(["A:failed"]);

    // Two days of outage. B would be far overdue, A might have recovered:
    // we cannot know either, so nothing changes.
    vendor.down = true;
    for (const hours of [12, 24, 48])
      await expect(sync(at(hours))).rejects.toThrow("vendor is down");
    expect(await incidents()).toEqual(before);

    // When the vendor is back, the truth is applied in one step.
    vendor.down = false;
    vendor.result("A", at(47), "success");
    const summary = await sync(at(49));
    expect(summary).toMatchObject({ incidentsOpened: 1, incidentsClosed: 1 });
    expect(
      (await incidents()).filter((i) => i.closedAt === null).map((i) => `${i.asset}:${i.type}`),
    ).toEqual(["B:missed"]);
  });
});

describe("incidents: acknowledgement and integrity", () => {
  it("keeps who acknowledged an incident, while it is open and after it closes", async () => {
    const vendor = new ScriptedVendor().result("A", at(-1), "failed");
    const { tenantId, sync, incidents } = await setup(vendor);
    await sync(T0);
    const user = await db.withTenant(tenantId, ({ tx }) =>
      tx.user.create({ data: { tenantId, clerkUserId: "user_tech", email: "t@msp.example" } }),
    );
    await db.withTenant(tenantId, ({ tx }) =>
      tx.incident.updateMany({ data: { acknowledgedByUserId: user.id, acknowledgedAt: at(0.5) } }),
    );

    vendor.result("A", at(1), "failed");
    await sync(at(1.5));
    expect(await incidents()).toMatchObject([{ closedAt: null, acknowledgedByUserId: user.id }]);

    vendor.result("A", at(2), "success");
    await sync(at(2.5));
    expect(await incidents()).toMatchObject([{ closedAt: at(2.5), acknowledgedByUserId: user.id }]);
  });

  it("never has two open incidents of one type for an asset", async () => {
    const vendor = new ScriptedVendor()
      .result("A", at(-40), "success")
      .result("A", at(-1), "failed");
    const { sync, incidents } = await setup(vendor);
    for (const hours of [0, 0.25, 0.5, 1, 2]) await sync(at(hours));
    const openOnes = (await incidents()).filter((i) => i.closedAt === null);
    expect(openOnes.map((i) => i.type).sort()).toEqual(["failed", "missed"]);
  });

  it("running the same sync twice changes nothing the second time", async () => {
    const vendor = new ScriptedVendor()
      .result("A", at(-40), "success")
      .result("A", at(-1), "failed");
    const { sync, incidents } = await setup(vendor);
    await sync(T0);
    const before = await incidents();
    const again = await sync(T0);
    expect(again).toMatchObject({ incidentsOpened: 0, incidentsClosed: 0 });
    expect(await incidents()).toEqual(before);
  });

  it("one tenant's sync never touches another tenant's incidents", async () => {
    const one = await setup(new ScriptedVendor().result("A", at(-1), "failed"));
    const twoVendor = new ScriptedVendor().result("A", at(-1), "failed");
    const two = await setup(twoVendor);
    await one.sync(T0);
    await two.sync(T0);

    twoVendor.result("A", at(1), "success");
    await two.sync(at(2));
    expect(await one.open()).toEqual(["A:failed"]);
    expect(await two.open()).toEqual([]);
  });

  it("the demo vendor produces a sensible set of open incidents", async () => {
    const tenantId = await db.provisionTenant({ clerkOrgId: `org_${randomUUID()}`, name: "Demo" });
    const integration = await db.withTenant(tenantId, (context) =>
      createIntegration(context, keyProvider, {
        vendor: "mock",
        name: "Demo data",
        credentials: new Secret({ seed: "demo" }),
        actorUserId: null,
      }),
    );
    const summary = await syncIntegration(
      { db, keyProvider, logger, allowMock: true, now: () => T0 },
      { tenantId, integrationId: integration.id },
    );
    const rows = await db.withTenant(tenantId, ({ tx }) =>
      tx.incident.findMany({ include: { asset: true } }),
    );

    expect(summary.incidentsOpened).toBe(rows.length);
    expect(rows.some((i) => i.type === "failed")).toBe(true);
    expect(rows.some((i) => i.type === "missed")).toBe(true);
    for (const incident of rows) {
      expect(incident.closedAt).toBeNull();
      expect(incident.asset.isPaused || incident.asset.isArchived).toBe(false);
      if (incident.type === "failed") expect(incident.asset.lastResultStatus).toBe("failed");
    }
    // A real fleet is mostly fine: incidents are the exception.
    expect(rows.length).toBeLessThan(summary.assets / 3);
  });
});
