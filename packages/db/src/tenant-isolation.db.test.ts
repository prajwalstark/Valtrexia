import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  asTenant,
  PG,
  pgCode,
  seedTenant,
  TENANT_TABLES,
  type SeededTenant,
} from "../test/fixtures";
import { createDb, InvalidTenantIdError, UnsafeDatabaseRoleError, type Db } from "./index";

const urls = inject("databaseUrls");

const RLS_VIOLATION = /row-level security/;

let db: Db;
/** Raw connections as the runtime role, for probing underneath the query builder. */
let app: pg.Pool;
/** Raw connections as the owner, for reading the catalog and checking what really got stored. */
let owner: pg.Pool;
let a: SeededTenant;
let b: SeededTenant;

beforeAll(async () => {
  db = createDb({ url: urls.app });
  app = new pg.Pool({ connectionString: urls.app, max: 4 });
  owner = new pg.Pool({ connectionString: urls.owner, max: 2 });
  a = await seedTenant(db, "alpha");
  b = await seedTenant(db, "bravo");
});

afterAll(async () => {
  await db.disconnect();
  await app.end();
  await owner.end();
});

async function ownerCount(table: string, id: string): Promise<number> {
  const result = await owner.query(`SELECT count(*)::int AS n FROM ${table} WHERE id = $1`, [id]);
  return result.rows[0].n;
}

describe("catalog: every table is protected", () => {
  it("the isolation tests cover every table that has a tenant_id column", async () => {
    const result = await owner.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'tenant_id'
      ORDER BY table_name
    `);
    expect(result.rows.map((row) => row.table_name)).toEqual([...TENANT_TABLES].sort());
  });

  it("has no table outside the tenant model", async () => {
    // Anything new must either carry tenant_id or be added here deliberately.
    const result = await owner.query<{ tablename: string }>(`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
    `);
    expect(result.rows.map((row) => row.tablename)).toEqual(
      [...TENANT_TABLES, "tenants", "_prisma_migrations"].sort(),
    );
  });

  it("row-level security is enabled on tenants and on every tenant table", async () => {
    const result = await owner.query<{ relname: string; relrowsecurity: boolean }>(
      `SELECT c.relname, c.relrowsecurity
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = ANY($1)`,
      [[...TENANT_TABLES, "tenants"]],
    );
    expect(result.rows).toHaveLength(TENANT_TABLES.length + 1);
    for (const row of result.rows) {
      expect(row.relrowsecurity, `${row.relname} has row-level security enabled`).toBe(true);
    }
  });

  it("every tenant table has one policy, for all commands and all roles, keyed on the tenant", async () => {
    const result = await owner.query<{
      tablename: string;
      cmd: string;
      roles: string;
      qual: string;
      with_check: string;
    }>(
      `SELECT tablename, cmd, roles::text AS roles, qual, with_check
       FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY($1)`,
      [[...TENANT_TABLES]],
    );
    expect(result.rows.map((row) => row.tablename).sort()).toEqual([...TENANT_TABLES].sort());
    for (const row of result.rows) {
      expect(row.cmd, row.tablename).toBe("ALL");
      expect(row.roles, row.tablename).toBe("{public}");
      expect(row.qual, row.tablename).toMatch(/tenant_id = .*app_current_tenant_id\(\)/s);
      expect(row.with_check, row.tablename).toMatch(/tenant_id = .*app_current_tenant_id\(\)/s);
    }
  });

  it("the cross-tenant functions pin search_path and are not executable by PUBLIC", async () => {
    const result = await owner.query<{
      proname: string;
      prosecdef: boolean;
      proconfig: string[] | null;
      public_can_execute: boolean;
      app_can_execute: boolean;
    }>(`
      SELECT p.proname, p.prosecdef, p.proconfig,
             EXISTS (
               SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
               WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
             ) AS public_can_execute,
             has_function_privilege('valtrexia_app', p.oid, 'EXECUTE') AS app_can_execute
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosecdef
      ORDER BY p.proname
    `);
    expect(result.rows.map((row) => row.proname)).toEqual([
      "list_due_integrations",
      "provision_tenant",
      "resolve_tenant_id",
    ]);
    for (const row of result.rows) {
      expect(row.proconfig, row.proname).toEqual(["search_path=pg_catalog, pg_temp"]);
      expect(row.public_can_execute, row.proname).toBe(false);
      expect(row.app_can_execute, row.proname).toBe(true);
    }
  });
});

describe("runtime role", () => {
  it("is not a superuser, cannot bypass row-level security and owns no tables", async () => {
    const role = await app.query(`
      SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
      FROM pg_roles WHERE rolname = current_user
    `);
    expect(role.rows[0]).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
    });
    const owned = await app.query(
      `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user`,
    );
    expect(owned.rows[0].n).toBe(0);
  });

  it("passes the startup role guard", async () => {
    await expect(db.assertSafeRole()).resolves.toBeUndefined();
  });

  it("the startup role guard rejects the owner role", async () => {
    const asOwner = createDb({ url: urls.owner, maxConnections: 1 });
    try {
      await expect(asOwner.assertSafeRole()).rejects.toBeInstanceOf(UnsafeDatabaseRoleError);
    } finally {
      await asOwner.disconnect();
    }
  });

  it("has only the table privileges it needs", async () => {
    const result = await app.query<{ t: string; p: string; allowed: boolean }>(`
      SELECT t, p, has_table_privilege(current_user, t, p) AS allowed
      FROM (VALUES
        ('audit_logs', 'UPDATE'), ('audit_logs', 'DELETE'), ('audit_logs', 'TRUNCATE'),
        ('tenants', 'INSERT'), ('tenants', 'DELETE'), ('tenants', 'UPDATE'),
        ('_prisma_migrations', 'SELECT'),
        ('clients', 'TRUNCATE'), ('backup_results', 'TRUNCATE')
      ) AS checks(t, p)
    `);
    for (const row of result.rows) {
      expect(row.allowed, `${row.p} on ${row.t}`).toBe(false);
    }
  });
});

describe.each(TENANT_TABLES)("isolation: %s", (table) => {
  it("a tenant sees its own row and not the other tenant's", async () => {
    await asTenant(app, a.tenantId, async (client) => {
      const all = await client.query(`SELECT id, tenant_id FROM ${table}`);
      expect(all.rows).toEqual([{ id: a.rows[table], tenant_id: a.tenantId }]);

      const theirs = await client.query(`SELECT id FROM ${table} WHERE id = $1`, [b.rows[table]]);
      expect(theirs.rowCount).toBe(0);
    });
  });

  it("returns nothing when no tenant is set", async () => {
    await asTenant(app, null, async (client) => {
      const result = await client.query(`SELECT id FROM ${table}`);
      expect(result.rowCount).toBe(0);
    });
  });

  it("returns nothing for a tenant id that does not exist", async () => {
    await asTenant(app, randomUUID(), async (client) => {
      const result = await client.query(`SELECT id FROM ${table}`);
      expect(result.rowCount).toBe(0);
    });
  });

  it("cannot update the other tenant's row", async () => {
    // audit_logs is append-only, so the attempt is refused outright.
    const attempt = asTenant(app, a.tenantId, (client) =>
      client.query(`UPDATE ${table} SET tenant_id = tenant_id WHERE id = $1`, [b.rows[table]]),
    );
    if (table === "audit_logs") {
      await expect(attempt).rejects.toSatisfy((e) => pgCode(e) === PG.insufficientPrivilege);
    } else {
      expect((await attempt).rowCount).toBe(0);
    }
  });

  it("cannot delete the other tenant's row", async () => {
    const attempt = asTenant(app, a.tenantId, (client) =>
      client.query(`DELETE FROM ${table} WHERE id = $1`, [b.rows[table]]),
    );
    if (table === "audit_logs") {
      await expect(attempt).rejects.toSatisfy((e) => pgCode(e) === PG.insufficientPrivilege);
    } else {
      expect((await attempt).rowCount).toBe(0);
    }
    expect(await ownerCount(table, b.rows[table])).toBe(1);
  });

  it("cannot insert a row that belongs to the other tenant", async () => {
    // Clone this tenant's own row, give it a new id and the other tenant's id.
    const attempt = asTenant(app, a.tenantId, (client) =>
      client.query(
        `INSERT INTO ${table}
         SELECT (jsonb_populate_record(
           NULL::${table},
           to_jsonb(src) || jsonb_build_object('id', gen_random_uuid(), 'tenant_id', $2::uuid)
         )).*
         FROM ${table} src WHERE src.id = $1`,
        [a.rows[table], b.tenantId],
      ),
    );
    await expect(attempt).rejects.toThrow(RLS_VIOLATION);
  });

  it("cannot insert a row when no tenant is set", async () => {
    const attempt = asTenant(app, null, (client) =>
      client.query(
        `INSERT INTO ${table}
         SELECT (jsonb_populate_record(
           NULL::${table},
           jsonb_build_object('id', gen_random_uuid(), 'tenant_id', $1::uuid)
         )).*`,
        [a.tenantId],
      ),
    );
    await expect(attempt).rejects.toThrow(RLS_VIOLATION);
  });

  it.skipIf(table === "audit_logs")("cannot move its own row to the other tenant", async () => {
    const attempt = asTenant(app, a.tenantId, (client) =>
      client.query(`UPDATE ${table} SET tenant_id = $2 WHERE id = $1`, [a.rows[table], b.tenantId]),
    );
    await expect(attempt).rejects.toThrow(RLS_VIOLATION);
  });
});

describe("isolation: tenants table", () => {
  it("a tenant sees only its own tenant row", async () => {
    await asTenant(app, a.tenantId, async (client) => {
      const result = await client.query("SELECT id FROM tenants");
      expect(result.rows).toEqual([{ id: a.tenantId }]);
    });
  });

  it("lists no tenants when no tenant is set", async () => {
    await asTenant(app, null, async (client) => {
      expect((await client.query("SELECT id FROM tenants")).rowCount).toBe(0);
    });
  });

  it("cannot create or delete tenants directly", async () => {
    const insert = asTenant(app, a.tenantId, (client) =>
      client.query("INSERT INTO tenants (clerk_org_id, name) VALUES ('org_rogue', 'Rogue')"),
    );
    await expect(insert).rejects.toSatisfy((e) => pgCode(e) === PG.insufficientPrivilege);

    const del = asTenant(app, a.tenantId, (client) =>
      client.query("DELETE FROM tenants WHERE id = $1", [a.tenantId]),
    );
    await expect(del).rejects.toSatisfy((e) => pgCode(e) === PG.insufficientPrivilege);
  });

  it("cannot re-point itself at another Clerk organization", async () => {
    const attempt = asTenant(app, a.tenantId, (client) =>
      client.query("UPDATE tenants SET clerk_org_id = $1 WHERE id = $2", [
        b.clerkOrgId,
        a.tenantId,
      ]),
    );
    await expect(attempt).rejects.toSatisfy((e) => pgCode(e) === PG.insufficientPrivilege);
  });

  it("can rename itself but not the other tenant", async () => {
    await asTenant(app, a.tenantId, async (client) => {
      const own = await client.query("UPDATE tenants SET name = 'Renamed' WHERE id = $1", [
        a.tenantId,
      ]);
      expect(own.rowCount).toBe(1);
      const other = await client.query("UPDATE tenants SET name = 'Hijacked' WHERE id = $1", [
        b.tenantId,
      ]);
      expect(other.rowCount).toBe(0);
    });
  });
});

describe("cross-tenant references", () => {
  // Foreign-key checks bypass row-level security. Without the composite keys,
  // each of these inserts would succeed and attach to the other tenant's data.
  it("an asset cannot point at the other tenant's client", async () => {
    const attempt = asTenant(app, a.tenantId, (client) =>
      client.query(
        `INSERT INTO assets (tenant_id, client_id, integration_id, vendor_asset_id, name, type)
         VALUES ($1, $2, $3, 'va-cross', 'cross', 'agent')`,
        [a.tenantId, b.rows.clients, a.rows.integrations],
      ),
    );
    await expect(attempt).rejects.toSatisfy((e) => pgCode(e) === PG.foreignKeyViolation);
  });

  it("a backup result cannot point at the other tenant's asset", async () => {
    const attempt = asTenant(app, a.tenantId, (client) =>
      client.query(
        `INSERT INTO backup_results
           (tenant_id, asset_id, integration_id, vendor_result_id, started_at, status, vendor_status_raw, raw_payload)
         VALUES ($1, $2, $3, 'vr-cross', now(), 'success', 'OK', '{}')`,
        [a.tenantId, b.rows.assets, a.rows.integrations],
      ),
    );
    await expect(attempt).rejects.toSatisfy((e) => pgCode(e) === PG.foreignKeyViolation);
  });

  it("an incident cannot be acknowledged by the other tenant's user", async () => {
    const attempt = asTenant(app, a.tenantId, (client) =>
      client.query(
        "UPDATE incidents SET acknowledged_by_user_id = $1, acknowledged_at = now() WHERE id = $2",
        [b.rows.users, a.rows.incidents],
      ),
    );
    await expect(attempt).rejects.toSatisfy((e) => pgCode(e) === PG.foreignKeyViolation);
  });

  it("an audit entry cannot name the other tenant's user as actor", async () => {
    const attempt = asTenant(app, a.tenantId, (client) =>
      client.query(
        `INSERT INTO audit_logs (tenant_id, actor_type, actor_user_id, action)
         VALUES ($1, 'user', $2, 'test.cross')`,
        [a.tenantId, b.rows.users],
      ),
    );
    await expect(attempt).rejects.toSatisfy((e) => pgCode(e) === PG.foreignKeyViolation);
  });
});

describe("withTenant", () => {
  it("confines the query builder to the tenant", async () => {
    const seen = await db.withTenant(a.tenantId, ({ tx }) => tx.client.findMany());
    expect(seen.map((client) => client.id)).toEqual([a.rows.clients]);

    const theirs = await db.withTenant(a.tenantId, ({ tx }) =>
      tx.asset.findUnique({ where: { id: b.rows.assets } }),
    );
    expect(theirs).toBeNull();
  });

  it("includes do not reach across tenants", async () => {
    const tenant = await db.withTenant(a.tenantId, ({ tx }) =>
      tx.tenant.findMany({ include: { clients: true, integrations: true } }),
    );
    expect(tenant).toHaveLength(1);
    expect(tenant[0]?.clients.map((client) => client.id)).toEqual([a.rows.clients]);
    expect(tenant[0]?.integrations.map((integration) => integration.id)).toEqual([
      a.rows.integrations,
    ]);
  });

  it("rejects a write that names the other tenant", async () => {
    await expect(
      db.withTenant(a.tenantId, ({ tx }) =>
        tx.client.create({ data: { tenantId: b.tenantId, name: "Planted" } }),
      ),
    ).rejects.toThrow();
    const planted = await owner.query(
      "SELECT count(*)::int AS n FROM clients WHERE name = 'Planted'",
    );
    expect(planted.rows[0].n).toBe(0);
  });

  it("an update aimed at the other tenant's row changes nothing", async () => {
    const result = await db.withTenant(a.tenantId, ({ tx }) =>
      tx.asset.updateMany({ where: { id: b.rows.assets }, data: { name: "tampered" } }),
    );
    expect(result.count).toBe(0);
    const row = await owner.query("SELECT name FROM assets WHERE id = $1", [b.rows.assets]);
    expect(row.rows[0].name).toBe("bravo-dc01");
  });

  it("rejects anything that is not a UUID before touching the database", async () => {
    for (const bad of ["", "not-a-uuid", `${a.tenantId}' OR '1'='1`, "*"]) {
      await expect(db.withTenant(bad, async () => "ran")).rejects.toBeInstanceOf(
        InvalidTenantIdError,
      );
    }
  });

  it("rolls back everything when the callback throws", async () => {
    await expect(
      db.withTenant(a.tenantId, async ({ tx, tenantId }) => {
        await tx.client.create({ data: { tenantId, name: "Should not persist" } });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const rows = await owner.query(
      "SELECT count(*)::int AS n FROM clients WHERE name = 'Should not persist'",
    );
    expect(rows.rows[0].n).toBe(0);
  });

  it("does not leak one tenant's context to the next use of a pooled connection", async () => {
    // One connection, so every transaction reuses it.
    const single = createDb({ url: urls.app, maxConnections: 1 });
    try {
      await single.withTenant(a.tenantId, ({ tx }) => tx.client.findMany());
      const afterA = await single.withTenant(b.tenantId, ({ tx }) => tx.client.findMany());
      expect(afterA.map((client) => client.id)).toEqual([b.rows.clients]);

      // A failed transaction must not leave its tenant behind either.
      await single
        .withTenant(a.tenantId, async () => {
          throw new Error("fail mid-transaction");
        })
        .catch(() => undefined);
      const afterFailure = await single.withTenant(b.tenantId, ({ tx }) => tx.client.findMany());
      expect(afterFailure.map((client) => client.id)).toEqual([b.rows.clients]);
    } finally {
      await single.disconnect();
    }
  });

  it("keeps tenants apart under concurrent, interleaved transactions", async () => {
    const small = createDb({ url: urls.app, maxConnections: 2 });
    try {
      const runs = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? a : b));
      const results = await Promise.all(
        runs.map((tenant) =>
          small.withTenant(tenant.tenantId, async ({ tx }) => {
            const first = await tx.asset.findMany();
            const second = await tx.backupResult.findMany();
            return { tenant, assets: first, results: second };
          }),
        ),
      );
      for (const { tenant, assets, results: backupResults } of results) {
        expect(assets.map((asset) => asset.id)).toEqual([tenant.rows.assets]);
        expect(backupResults.map((result) => result.id)).toEqual([tenant.rows.backup_results]);
      }
    } finally {
      await small.disconnect();
    }
  });
});

describe("pre-tenant functions", () => {
  it("resolveTenantId maps a Clerk organization to its tenant, and unknown ones to null", async () => {
    expect(await db.resolveTenantId(a.clerkOrgId)).toBe(a.tenantId);
    expect(await db.resolveTenantId(b.clerkOrgId)).toBe(b.tenantId);
    expect(await db.resolveTenantId("org_does_not_exist")).toBeNull();
  });

  it("provisionTenant is idempotent and does not rename an existing tenant", async () => {
    const clerkOrgId = `org_${randomUUID()}`;
    const first = await db.provisionTenant({ clerkOrgId, name: "First name" });
    const second = await db.provisionTenant({ clerkOrgId, name: "Second name" });
    expect(second).toBe(first);
    const row = await owner.query("SELECT name, grace_hours FROM tenants WHERE id = $1", [first]);
    expect(row.rows[0]).toEqual({ name: "First name", grace_hours: 2 });
  });

  it("provisionTenant rejects a blank organization id or name", async () => {
    await expect(db.provisionTenant({ clerkOrgId: " ", name: "x" })).rejects.toThrow();
    await expect(
      db.provisionTenant({ clerkOrgId: `org_${randomUUID()}`, name: "  " }),
    ).rejects.toThrow();
  });

  it("listDueIntegrations returns ids only, across tenants, and skips recently started syncs", async () => {
    const due = await db.listDueIntegrations({ intervalMinutes: 15 });
    expect(due).toEqual(
      expect.arrayContaining([
        { integrationId: a.rows.integrations, tenantId: a.tenantId },
        { integrationId: b.rows.integrations, tenantId: b.tenantId },
      ]),
    );
    for (const row of due) expect(Object.keys(row).sort()).toEqual(["integrationId", "tenantId"]);

    // Mark A's integration as started just now. Inside a transaction that is
    // rolled back, so later tests still see it as due.
    const temp = await db.provisionTenant({ clerkOrgId: `org_${randomUUID()}`, name: "Temp" });
    const tempIntegration = await db.withTenant(temp, ({ tx, tenantId }) =>
      tx.integration.create({
        data: {
          tenantId,
          vendor: "mock",
          name: "just started",
          credentialsEnc: {},
          lastSyncStartedAt: new Date(),
        },
      }),
    );
    const after = await db.listDueIntegrations({ intervalMinutes: 15 });
    expect(after.map((row) => row.integrationId)).not.toContain(tempIntegration.id);
    const everything = await db.listDueIntegrations({ intervalMinutes: 0 });
    expect(everything.map((row) => row.integrationId)).toContain(tempIntegration.id);
  });
});

describe("constraints", () => {
  it("allows only one open incident per asset per type", async () => {
    await expect(
      db.withTenant(a.tenantId, ({ tx, tenantId }) =>
        tx.incident.create({ data: { tenantId, assetId: a.rows.assets, type: "failed" } }),
      ),
    ).rejects.toThrow();

    // A different type, or the same type once the first is closed, is fine.
    await db.withTenant(a.tenantId, async ({ tx, tenantId }) => {
      const missed = await tx.incident.create({
        data: { tenantId, assetId: a.rows.assets, type: "missed" },
      });
      await tx.incident.delete({ where: { id: missed.id } });
    });
  });

  it("audit entries cannot be changed or removed through the query builder", async () => {
    await expect(
      db.withTenant(a.tenantId, ({ tx }) =>
        tx.auditLog.update({ where: { id: a.rows.audit_logs }, data: { action: "rewritten" } }),
      ),
    ).rejects.toThrow();
    await expect(
      db.withTenant(a.tenantId, ({ tx }) =>
        tx.auditLog.delete({ where: { id: a.rows.audit_logs } }),
      ),
    ).rejects.toThrow();
    const row = await owner.query("SELECT action FROM audit_logs WHERE id = $1", [
      a.rows.audit_logs,
    ]);
    expect(row.rows[0].action).toBe("integration.created");
  });
});
