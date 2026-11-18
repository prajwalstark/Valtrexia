import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { PG, pgCode, seedTenant, TENANT_TABLES } from "../test/fixtures";
import { cancelTenantDeletion, createDb, requestTenantDeletion, type Db } from "./index";

const urls = inject("databaseUrls");
let db: Db;
let owner: pg.Pool;
let app: pg.Pool;
beforeAll(() => {
  db = createDb({ url: urls.app });
  owner = new pg.Pool({ connectionString: urls.owner, max: 2 });
  app = new pg.Pool({ connectionString: urls.app, max: 2 });
});
afterAll(async () => {
  await db.disconnect();
  await owner.end();
  await app.end();
});

const DAY = 86_400_000;

/** Rows the tenant has left in every tenant table, read as the owner (no row-level security). */
async function rowsLeft(tenantId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of [...TENANT_TABLES, "tenants"]) {
    const column = table === "tenants" ? "id" : "tenant_id";
    const { rows } = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${table} WHERE ${column} = $1`,
      [tenantId],
    );
    counts[table] = rows[0]!.n;
  }
  return counts;
}

/** Marks a tenant as if it had been requested `daysAgo` days ago, with the usual 30-day hold. */
async function markedDaysAgo(tenantId: string, daysAgo: number) {
  await db.withTenant(tenantId, (context) =>
    requestTenantDeletion(context, {
      reason: "owner_request",
      now: new Date(Date.now() - daysAgo * DAY),
      actorUserId: null,
    }),
  );
}

describe("tenant offboarding", () => {
  it("deletes a tenant whose hold has passed, with every row it owns, and records it outside", async () => {
    const gone = await seedTenant(db, "gone");
    const waiting = await seedTenant(db, "waiting");
    const kept = await seedTenant(db, "kept");
    await markedDaysAgo(gone.tenantId, 31);
    await markedDaysAgo(waiting.tenantId, 29);

    // Other test files purge too; this tenant must be among the deleted, whoever deletes it.
    const deleted = await db.purgeDueTenants({ limit: 100 });
    const left = await rowsLeft(gone.tenantId);
    expect(
      Object.values(left).every((n) => n === 0),
      JSON.stringify(left),
    ).toBe(true);
    if (deleted.length > 0) expect(deleted).not.toContain(waiting.tenantId);

    for (const t of [waiting, kept]) {
      const rows = await rowsLeft(t.tenantId);
      expect(
        Object.values(rows).every((n) => n >= 1),
        `${t.clerkOrgId}: ${JSON.stringify(rows)}`,
      ).toBe(true);
    }

    const { rows } = await owner.query(
      "SELECT clerk_org_id, tenant_name, reason FROM tenant_deletions WHERE deleted_tenant_id = $1",
      [gone.tenantId],
    );
    expect(rows).toEqual([
      { clerk_org_id: gone.clerkOrgId, tenant_name: expect.any(String), reason: "owner_request" },
    ]);
  });

  it("stops syncing and notifying a tenant marked for deletion, and resumes when cancelled", async () => {
    const t = await seedTenant(db, "paused");
    // Make the seeded integration due and its batch pending now.
    await owner.query("UPDATE integrations SET last_sync_started_at = NULL WHERE tenant_id = $1", [
      t.tenantId,
    ]);
    await owner.query(
      "UPDATE notification_batches SET status = 'pending', next_attempt_at = now() - interval '1 minute' WHERE tenant_id = $1",
      [t.tenantId],
    );
    const due = async () => ({
      integrations: (await db.listDueIntegrations({ intervalMinutes: 15, limit: 1000 })).some(
        (row) => row.tenantId === t.tenantId,
      ),
      batches: (await db.listDueNotificationBatches({ limit: 1000 })).some(
        (row) => row.tenantId === t.tenantId,
      ),
    });
    expect(await due()).toEqual({ integrations: true, batches: true });

    await markedDaysAgo(t.tenantId, 0);
    expect(await due()).toEqual({ integrations: false, batches: false });

    await db.withTenant(t.tenantId, (context) =>
      cancelTenantDeletion(context, { actorUserId: null }),
    );
    expect(await due()).toEqual({ integrations: true, batches: true });
  });

  it("never moves an existing deletion date, and audits each request and cancellation", async () => {
    const t = await seedTenant(db, "audited");
    await markedDaysAgo(t.tenantId, 3);
    const again = await db.withTenant(t.tenantId, (context) =>
      requestTenantDeletion(context, {
        reason: "organization_deleted",
        now: new Date(),
        actorUserId: null,
      }),
    );
    expect(again.changed).toBe(false);
    expect(again.pending.reason).toBe("owner_request");
    expect(
      await db.withTenant(t.tenantId, (context) =>
        cancelTenantDeletion(context, { actorUserId: null }),
      ),
    ).toBe(true);
    expect(
      await db.withTenant(t.tenantId, (context) =>
        cancelTenantDeletion(context, { actorUserId: null }),
      ),
    ).toBe(false);
    const actions = await db.withTenant(t.tenantId, async ({ tx }) =>
      (
        await tx.auditLog.findMany({
          where: { action: { startsWith: "workspace.deletion" } },
          orderBy: { createdAt: "asc" },
        })
      ).map((e) => e.action),
    );
    expect(actions).toEqual(["workspace.deletion_requested", "workspace.deletion_cancelled"]);
  });

  it("refuses a hold shorter than a week, or a partial mark, in the database", async () => {
    const t = await seedTenant(db, "constrained");
    const attempt = (data: Record<string, unknown>) =>
      db.withTenant(t.tenantId, ({ tx }) => tx.tenant.update({ where: { id: t.tenantId }, data }));
    const now = new Date();
    for (const data of [
      {
        deletionRequestedAt: now,
        deleteAfter: new Date(now.getTime() + 6 * DAY),
        deletionReason: "owner_request",
      },
      { deletionRequestedAt: now, deleteAfter: null, deletionReason: "owner_request" },
      {
        deletionRequestedAt: null,
        deleteAfter: new Date(now.getTime() + 40 * DAY),
        deletionReason: null,
      },
    ]) {
      await expect(attempt(data)).rejects.toThrow();
    }
  });

  it("gives the runtime role no access to the record of deletions, and no way to delete a tenant", async () => {
    await expect(app.query("SELECT * FROM tenant_deletions")).rejects.toSatisfy(
      (e) => pgCode(e) === PG.insufficientPrivilege,
    );
    const t = await seedTenant(db, "undeletable");
    const client = await app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [t.tenantId]);
      await expect(
        client.query("DELETE FROM tenants WHERE id = $1", [t.tenantId]),
      ).rejects.toSatisfy((e) => pgCode(e) === PG.insufficientPrivilege);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});
