import { PrismaPg } from "@prisma/adapter-pg";
import { InvalidTenantIdError, UnsafeDatabaseRoleError } from "./errors";
import { Prisma, PrismaClient } from "./generated/prisma/client";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The transaction client handed to tenant-scoped code. Raw SQL methods are
 * removed from the type so that nothing downstream can change the tenant
 * context or step around the query builder.
 */
export type TenantTx = Omit<
  Prisma.TransactionClient,
  "$executeRaw" | "$executeRawUnsafe" | "$queryRaw" | "$queryRawUnsafe"
>;

export interface TenantContext {
  /** The tenant every query in this transaction is confined to. */
  readonly tenantId: string;
  readonly tx: TenantTx;
}

export interface TransactionOptions {
  /** How long the transaction may run. Default 10 seconds. */
  timeoutMs?: number;
  /** How long to wait for a free connection. Default 5 seconds. */
  maxWaitMs?: number;
}

export interface DueIntegration {
  integrationId: string;
  tenantId: string;
}

export interface Db {
  /**
   * Runs `fn` in a transaction confined to one tenant by row-level security.
   * This is the only way to reach tenant data.
   *
   * `tenantId` must come from a verified session or from `resolveTenantId`,
   * never from a URL, form field or header.
   */
  withTenant<T>(
    tenantId: string,
    fn: (context: TenantContext) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>;

  /** The tenant for a Clerk organization, or null when it has not been provisioned. */
  resolveTenantId(clerkOrgId: string): Promise<string | null>;

  /** Creates the tenant for a Clerk organization, or returns the existing one unchanged. */
  provisionTenant(input: { clerkOrgId: string; name: string }): Promise<string>;

  /**
   * Integrations whose last sync started longer ago than `intervalMinutes`,
   * across all tenants. Ids only; the scheduler's single cross-tenant read.
   */
  listDueIntegrations(input: {
    intervalMinutes: number;
    limit?: number;
  }): Promise<DueIntegration[]>;

  /**
   * Throws unless the connection's role is safe to serve tenants with: not a
   * superuser, unable to bypass row-level security, and not an owner of any
   * table. Call once at process start.
   */
  assertSafeRole(): Promise<void>;

  disconnect(): Promise<void>;
}

export interface CreateDbOptions {
  /** Connection string for the runtime role. */
  url: string;
  /** Pool size. Default 10. */
  maxConnections?: number;
}

export function createDb({ url, maxConnections = 10 }: CreateDbOptions): Db {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url, max: maxConnections }),
  });

  return {
    async withTenant(tenantId, fn, options = {}) {
      if (typeof tenantId !== "string" || !UUID.test(tenantId)) throw new InvalidTenantIdError();

      return prisma.$transaction(
        async (tx) => {
          // Transaction-local (third argument true): the setting disappears
          // at commit or rollback, so a pooled connection never carries one
          // tenant's context into the next request.
          await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
          return fn({ tenantId, tx });
        },
        { timeout: options.timeoutMs ?? 10_000, maxWait: options.maxWaitMs ?? 5_000 },
      );
    },

    async resolveTenantId(clerkOrgId) {
      const rows = await prisma.$queryRaw<{ id: string | null }[]>`
        SELECT resolve_tenant_id(${clerkOrgId}) AS id
      `;
      return rows[0]?.id ?? null;
    },

    async provisionTenant({ clerkOrgId, name }) {
      const rows = await prisma.$queryRaw<{ id: string }[]>`
        SELECT provision_tenant(${clerkOrgId}, ${name}) AS id
      `;
      const id = rows[0]?.id;
      if (!id) throw new Error("provision_tenant returned no tenant id");
      return id;
    },

    async listDueIntegrations({ intervalMinutes, limit = 500 }) {
      if (!Number.isFinite(intervalMinutes) || intervalMinutes < 0) {
        throw new RangeError("intervalMinutes must be zero or greater");
      }
      const rows = await prisma.$queryRaw<{ integration_id: string; tenant_id: string }[]>`
        SELECT integration_id, tenant_id
        FROM list_due_integrations(make_interval(mins => ${Math.floor(intervalMinutes)}::int), ${Math.floor(limit)}::int)
      `;
      return rows.map((row) => ({ integrationId: row.integration_id, tenantId: row.tenant_id }));
    },

    async assertSafeRole() {
      const rows = await prisma.$queryRaw<
        { role: string; superuser: boolean; bypass_rls: boolean; owns_tables: boolean }[]
      >`
        SELECT
          r.rolname AS role,
          r.rolsuper AS superuser,
          r.rolbypassrls AS bypass_rls,
          EXISTS (
            SELECT 1
            FROM pg_catalog.pg_class c
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND c.relkind IN ('r', 'p')
              AND pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE')
          ) AS owns_tables
        FROM pg_catalog.pg_roles r
        WHERE r.rolname = current_user
      `;
      const row = rows[0];
      if (!row) throw new Error("Could not read the current database role");

      const reasons: string[] = [];
      if (row.superuser) reasons.push("it is a superuser");
      if (row.bypass_rls) reasons.push("it can bypass row-level security");
      if (row.owns_tables) reasons.push("it owns application tables");
      if (reasons.length > 0) throw new UnsafeDatabaseRoleError(row.role, reasons);
    },

    async disconnect() {
      await prisma.$disconnect();
    },
  };
}

let shared: Db | undefined;

/** The process-wide database handle, connected with DATABASE_URL. */
export function getDb(): Db {
  if (!shared) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    shared = createDb({ url });
  }
  return shared;
}
