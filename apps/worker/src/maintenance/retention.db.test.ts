import { randomBytes, randomUUID } from "node:crypto";
import { createLogger, LocalKeyProvider, Secret } from "@valtrexia/core/server";
import { createDb, createIntegration, type Db } from "@valtrexia/db";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { applyRetention, DEFAULT_RETENTION } from "./retention";

const urls = inject("databaseUrls");
let db: Db;
const logger = createLogger({ name: "retention-test", level: "silent" });
const keyProvider = new LocalKeyProvider(randomBytes(32).toString("base64"));
beforeAll(() => {
  db = createDb({ url: urls.app });
});
afterAll(async () => {
  await db.disconnect();
});

const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY);

/** A tenant with one asset and results and audit entries of the given ages, in days. */
async function tenantWith(resultAges: number[], auditAges: number[]) {
  const tenantId = await db.provisionTenant({ clerkOrgId: `org_${randomUUID()}`, name: "MSP" });
  await db.withTenant(tenantId, async (context) => {
    const { tx } = context;
    const integration = await createIntegration(context, keyProvider, {
      vendor: "mock",
      name: "Demo",
      credentials: new Secret({ seed: "x" }),
      actorUserId: null,
    });
    const client = await tx.client.create({ data: { tenantId, name: "Acme" } });
    const asset = await tx.asset.create({
      data: {
        tenantId,
        clientId: client.id,
        integrationId: integration.id,
        vendorAssetId: "a1",
        name: "SRV01",
        type: "agent",
      },
    });
    for (const age of resultAges) {
      await tx.backupResult.create({
        data: {
          tenantId,
          assetId: asset.id,
          integrationId: integration.id,
          vendorResultId: `r-${age}`,
          startedAt: daysAgo(age),
          endedAt: daysAgo(age),
          status: "success",
          vendorStatusRaw: "Success",
          rawPayload: { vendor: "record", age },
        },
      });
    }
  });
  // The runtime role cannot delete audit entries; add the aged ones alongside.
  await db.withTenant(tenantId, ({ tx }) =>
    tx.auditLog.createMany({
      data: auditAges.map((age) => ({
        tenantId,
        actorType: "system" as const,
        action: `test.aged_${age}`,
        createdAt: daysAgo(age),
      })),
    }),
  );
  return tenantId;
}

const results = (tenantId: string) =>
  db.withTenant(tenantId, ({ tx }) =>
    tx.backupResult.findMany({
      orderBy: { startedAt: "desc" },
      select: { vendorResultId: true, rawPayload: true },
    }),
  );
const auditActions = (tenantId: string) =>
  db.withTenant(tenantId, async ({ tx }) =>
    (await tx.auditLog.findMany({ where: { action: { startsWith: "test.aged_" } } }))
      .map((e) => e.action)
      .sort(),
  );

describe("retention", () => {
  it("empties old payloads, deletes old results and audit entries, in every tenant", async () => {
    const a = await tenantWith([1, 100, 500], [10, 800]);
    const b = await tenantWith([2, 91, 396], [729, 731]);
    await applyRetention({ db, logger }, DEFAULT_RETENTION);

    expect(await results(a)).toEqual([
      { vendorResultId: "r-1", rawPayload: { vendor: "record", age: 1 } },
      // Older than 90 days: the normalized result stays, the vendor's record goes.
      { vendorResultId: "r-100", rawPayload: {} },
    ]);
    expect(await results(b)).toEqual([
      { vendorResultId: "r-2", rawPayload: { vendor: "record", age: 2 } },
      { vendorResultId: "r-91", rawPayload: {} },
    ]);
    expect(await auditActions(a)).toEqual(["test.aged_10"]);
    expect(await auditActions(b)).toEqual(["test.aged_729"]);
  });

  it("works through more than one batch", async () => {
    const t = await tenantWith([200, 201, 202, 203, 204], []);
    const done = await applyRetention({ db, logger }, DEFAULT_RETENTION, { batchSize: 2 });
    expect(done.payloadsCleared).toBeGreaterThanOrEqual(5);
    expect((await results(t)).every((r) => JSON.stringify(r.rawPayload) === "{}")).toBe(true);
  });

  it("is refused by the database below the minimum periods", async () => {
    for (const policy of [
      { payloadDays: 6, resultDays: 395, auditDays: 730 },
      { payloadDays: 90, resultDays: 29, auditDays: 730 },
      { payloadDays: 90, resultDays: 395, auditDays: 89 },
    ]) {
      await expect(db.applyRetention(policy)).rejects.toThrow(/may not be shorter/);
    }
  });

  it("leaves the audit log append-only for the runtime role itself", async () => {
    const t = await tenantWith([], [800]);
    await db.withTenant(t, ({ tx }) => tx.auditLog.deleteMany({})).catch(() => undefined);
    expect(await auditActions(t)).toEqual(["test.aged_800"]);
  });
});
