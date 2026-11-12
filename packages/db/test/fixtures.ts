import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { Db } from "../src";

/** The id of one row in every tenant table, keyed by table name. */
export type RowIds = Record<(typeof TENANT_TABLES)[number], string>;

export interface SeededTenant {
  tenantId: string;
  clerkOrgId: string;
  rows: RowIds;
}

/**
 * Every table that carries tenant_id. A catalog test fails if this list and
 * the database disagree, so a new table cannot be added without being
 * covered by the isolation tests.
 */
export const TENANT_TABLES = [
  "users",
  "integrations",
  "clients",
  "vendor_client_mappings",
  "assets",
  "backup_results",
  "incidents",
  "audit_logs",
] as const;

/**
 * Provisions a tenant and inserts one row into every tenant table, using the
 * same code path the application uses: the runtime role inside `withTenant`.
 */
export async function seedTenant(db: Db, label: string): Promise<SeededTenant> {
  const clerkOrgId = `org_${label}_${randomUUID()}`;
  const tenantId = await db.provisionTenant({ clerkOrgId, name: `${label} MSP` });

  const rows = await db.withTenant(tenantId, async ({ tx }) => {
    const user = await tx.user.create({
      data: {
        tenantId,
        clerkUserId: `user_${label}`,
        email: `tech@${label}.example`,
        role: "owner",
      },
    });
    const integration = await tx.integration.create({
      data: {
        tenantId,
        vendor: "mock",
        name: `${label} mock`,
        credentialsEnc: { v: 1, ciphertext: `not-a-real-secret-${label}` },
      },
    });
    const client = await tx.client.create({ data: { tenantId, name: `${label} Dental` } });
    const mapping = await tx.vendorClientMapping.create({
      data: {
        tenantId,
        integrationId: integration.id,
        clientId: client.id,
        vendorClientId: `vc-${label}`,
        vendorClientName: `${label} Dental`,
      },
    });
    const asset = await tx.asset.create({
      data: {
        tenantId,
        clientId: client.id,
        integrationId: integration.id,
        vendorAssetId: `va-${label}`,
        name: `${label}-dc01`,
        type: "agent",
      },
    });
    const result = await tx.backupResult.create({
      data: {
        tenantId,
        assetId: asset.id,
        integrationId: integration.id,
        vendorResultId: `vr-${label}-1`,
        startedAt: new Date("2026-11-01T01:00:00Z"),
        endedAt: new Date("2026-11-01T01:20:00Z"),
        status: "success",
        vendorStatusRaw: "SUCCESS",
        rawPayload: { status: "SUCCESS" },
      },
    });
    const incident = await tx.incident.create({
      data: { tenantId, assetId: asset.id, type: "failed" },
    });
    const audit = await tx.auditLog.create({
      data: {
        tenantId,
        actorType: "user",
        actorUserId: user.id,
        action: "integration.created",
        targetType: "integration",
        targetId: integration.id,
      },
    });

    return {
      users: user.id,
      integrations: integration.id,
      clients: client.id,
      vendor_client_mappings: mapping.id,
      assets: asset.id,
      backup_results: result.id,
      incidents: incident.id,
      audit_logs: audit.id,
    } satisfies RowIds;
  });

  return { tenantId, clerkOrgId, rows };
}

/**
 * Runs raw SQL as the runtime role inside a tenant context, then rolls back.
 * Pass `null` to run with no tenant set. Used to probe the database directly,
 * underneath the query builder.
 */
export async function asTenant<T>(
  pool: pg.Pool,
  tenantId: string | null,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (tenantId) await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    return await fn(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

/** Postgres error codes the tests assert on. */
export const PG = {
  insufficientPrivilege: "42501",
  foreignKeyViolation: "23503",
} as const;

export function pgCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}
