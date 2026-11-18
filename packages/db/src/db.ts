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

export interface DueNotificationBatch {
  batchId: string;
  tenantId: string;
}

export interface DueIntegration {
  integrationId: string;
  tenantId: string;
}

/** The whole fleet's health, as counts across every tenant. No ids or names. */
export interface FleetHealthCounts {
  integrationsTotal: number;
  /** Whose last sync failed. */
  integrationsFailing: number;
  /** With no successful sync for longer than the overdue period. */
  integrationsOverdue: number;
  /** Notification messages still waiting more than 15 minutes after they were due. */
  batchesOverdue: number;
  /** Notification messages given up on in the last hour. */
  batchesFailedLastHour: number;
}

/** An alert to the operator about the service itself. */
export interface OperatorAlertRow {
  id: string;
  condition: string;
  openedAt: Date;
  closedAt: Date | null;
  details: Record<string, unknown>;
  openNotifiedAt: Date | null;
  closeNotifiedAt: Date | null;
}

export interface RetentionBatch {
  payloadsCleared: number;
  resultsDeleted: number;
  auditDeleted: number;
}

/** The kinds of record that hold an encrypted value. */
export type EncryptedRecordType = "integration" | "notification_channel";

/** An encrypted record, and the key its data key is wrapped under. No ciphertext. */
export interface EncryptedRecordRef {
  tenantId: string;
  type: EncryptedRecordType;
  id: string;
  /** Null when the stored value is not an envelope at all. */
  keyId: string | null;
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
   * Notification batches waiting to be sent whose time has come, across all
   * tenants. Ids only; each is then claimed and sent inside its own tenant.
   */
  listDueNotificationBatches(input?: { limit?: number }): Promise<DueNotificationBatch[]>;

  /**
   * Encrypted records, across all tenants, whose data key is not wrapped
   * under `excludeKeyId`: one page, after `after`, in a stable order. Ids and
   * key ids only; for the key rotation command.
   */
  listEncryptedRecords(input: {
    excludeKeyId: string;
    after?: Pick<EncryptedRecordRef, "tenantId" | "type" | "id"> | null;
    limit?: number;
  }): Promise<EncryptedRecordRef[]>;

  /**
   * One batch of retention across all tenants: empties raw payloads older
   * than `payloadDays`, deletes results older than `resultDays` and audit
   * entries older than `auditDays`. The database refuses periods shorter
   * than 7, 30 and 90 days. Call again while any count equals `batchSize`.
   */
  applyRetention(input: {
    payloadDays: number;
    resultDays: number;
    auditDays: number;
    batchSize?: number;
  }): Promise<RetentionBatch>;

  /**
   * Deletes up to `limit` workspaces whose deletion hold has passed, with
   * everything they own, recording each outside the tenant. Returns their ids.
   */
  purgeDueTenants(input?: { limit?: number }): Promise<string[]>;

  /** How many records of each type are wrapped under each key, across all tenants. */
  countEncryptedRecordsByKey(): Promise<
    { type: EncryptedRecordType; keyId: string | null; records: number }[]
  >;

  /** The fleet's health across every tenant, as counts. */
  fleetHealthCounts(input: { overdueAfterMinutes: number }): Promise<FleetHealthCounts>;

  /**
   * Opens an alert for `condition` unless one is already open. Returns the
   * new alert, or null if one was open (so the operator is told once).
   */
  openOperatorAlert(
    condition: string,
    details: Record<string, unknown>,
  ): Promise<OperatorAlertRow | null>;

  /** Closes the open alert for `condition`, if any. Returns it, or null. */
  closeOperatorAlert(condition: string, now?: Date): Promise<OperatorAlertRow | null>;

  /** Open alerts, oldest first. */
  openOperatorAlerts(): Promise<OperatorAlertRow[]>;

  /** Alerts whose opening or clearing has not been reported yet, opened after `since`. */
  operatorAlertsToNotify(since: Date): Promise<OperatorAlertRow[]>;

  /** Records that the operator was told an alert opened, or cleared. */
  markOperatorAlertNotified(id: string, event: "opened" | "closed", at?: Date): Promise<void>;

  /** Resolves when the database answers a trivial query. For readiness checks. */
  ping(): Promise<void>;

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

    async listDueNotificationBatches({ limit = 200 } = {}) {
      const rows = await prisma.$queryRaw<{ batch_id: string; tenant_id: string }[]>`
        SELECT batch_id, tenant_id FROM list_due_notification_batches(${Math.floor(limit)}::int)
      `;
      return rows.map((row) => ({ batchId: row.batch_id, tenantId: row.tenant_id }));
    },

    async listEncryptedRecords({ excludeKeyId, after = null, limit = 200 }) {
      const rows = await prisma.$queryRaw<
        {
          tenant_id: string;
          record_type: EncryptedRecordType;
          record_id: string;
          key_id: string | null;
        }[]
      >`
        SELECT tenant_id, record_type, record_id, key_id
        FROM list_encrypted_records(
          ${excludeKeyId}, ${after?.tenantId ?? null}::uuid, ${after?.type ?? null}::text,
          ${after?.id ?? null}::uuid, ${Math.floor(limit)}::int
        )
      `;
      return rows.map((row) => ({
        tenantId: row.tenant_id,
        type: row.record_type,
        id: row.record_id,
        keyId: row.key_id,
      }));
    },

    async applyRetention({ payloadDays, resultDays, auditDays, batchSize = 5000 }) {
      const rows = await prisma.$queryRaw<
        { payloads_cleared: bigint; results_deleted: bigint; audit_deleted: bigint }[]
      >`
        SELECT payloads_cleared, results_deleted, audit_deleted
        FROM apply_retention(
          ${Math.floor(payloadDays)}::int, ${Math.floor(resultDays)}::int,
          ${Math.floor(auditDays)}::int, ${Math.floor(batchSize)}::int
        )
      `;
      const row = rows[0];
      return {
        payloadsCleared: Number(row?.payloads_cleared ?? 0),
        resultsDeleted: Number(row?.results_deleted ?? 0),
        auditDeleted: Number(row?.audit_deleted ?? 0),
      };
    },

    async purgeDueTenants({ limit = 10 } = {}) {
      const rows = await prisma.$queryRaw<{ deleted_tenant_id: string }[]>`
        SELECT deleted_tenant_id FROM purge_due_tenants(${Math.floor(limit)}::int)
      `;
      return rows.map((row) => row.deleted_tenant_id);
    },

    async countEncryptedRecordsByKey() {
      const rows = await prisma.$queryRaw<
        { record_type: EncryptedRecordType; key_id: string | null; records: bigint }[]
      >`SELECT record_type, key_id, records FROM count_encrypted_records_by_key()`;
      return rows.map((row) => ({
        type: row.record_type,
        keyId: row.key_id,
        records: Number(row.records),
      }));
    },

    async fleetHealthCounts({ overdueAfterMinutes }) {
      const rows = await prisma.$queryRaw<
        {
          integrations_total: bigint;
          integrations_failing: bigint;
          integrations_overdue: bigint;
          batches_overdue: bigint;
          batches_failed_last_hour: bigint;
        }[]
      >`
        SELECT * FROM fleet_health_counts(make_interval(mins => ${Math.floor(overdueAfterMinutes)}::int))
      `;
      const row = rows[0]!;
      return {
        integrationsTotal: Number(row.integrations_total),
        integrationsFailing: Number(row.integrations_failing),
        integrationsOverdue: Number(row.integrations_overdue),
        batchesOverdue: Number(row.batches_overdue),
        batchesFailedLastHour: Number(row.batches_failed_last_hour),
      };
    },

    async openOperatorAlert(condition, details) {
      // The partial unique index makes a second open row for the condition
      // impossible; ON CONFLICT turns that into "nothing to do".
      const rows = await prisma.$queryRaw<OperatorAlertDbRow[]>`
        INSERT INTO operator_alerts (condition, details)
        VALUES (${condition}, ${JSON.stringify(details)}::jsonb)
        ON CONFLICT (condition) WHERE closed_at IS NULL DO NOTHING
        RETURNING *
      `;
      return rows[0] ? toAlert(rows[0]) : null;
    },

    async closeOperatorAlert(condition, now = new Date()) {
      const rows = await prisma.$queryRaw<OperatorAlertDbRow[]>`
        UPDATE operator_alerts SET closed_at = GREATEST(${now}::timestamptz, opened_at)
        WHERE condition = ${condition} AND closed_at IS NULL
        RETURNING *
      `;
      return rows[0] ? toAlert(rows[0]) : null;
    },

    async openOperatorAlerts() {
      const rows = await prisma.$queryRaw<OperatorAlertDbRow[]>`
        SELECT * FROM operator_alerts WHERE closed_at IS NULL ORDER BY opened_at
      `;
      return rows.map(toAlert);
    },

    async operatorAlertsToNotify(since) {
      const rows = await prisma.$queryRaw<OperatorAlertDbRow[]>`
        SELECT * FROM operator_alerts
        WHERE opened_at >= ${since}::timestamptz
          AND (open_notified_at IS NULL OR (closed_at IS NOT NULL AND close_notified_at IS NULL))
        ORDER BY opened_at
      `;
      return rows.map(toAlert);
    },

    async markOperatorAlertNotified(id, event, at = new Date()) {
      if (event === "opened") {
        await prisma.$executeRaw`UPDATE operator_alerts SET open_notified_at = ${at}::timestamptz WHERE id = ${id}::uuid`;
      } else {
        await prisma.$executeRaw`UPDATE operator_alerts SET close_notified_at = ${at}::timestamptz WHERE id = ${id}::uuid`;
      }
    },

    async ping() {
      await prisma.$queryRaw`SELECT 1`;
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

interface OperatorAlertDbRow {
  id: string;
  condition: string;
  opened_at: Date;
  closed_at: Date | null;
  details: unknown;
  open_notified_at: Date | null;
  close_notified_at: Date | null;
}

function toAlert(row: OperatorAlertDbRow): OperatorAlertRow {
  return {
    id: row.id,
    condition: row.condition,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    details:
      row.details && typeof row.details === "object"
        ? (row.details as Record<string, unknown>)
        : {},
    openNotifiedAt: row.open_notified_at,
    closeNotifiedAt: row.close_notified_at,
  };
}
