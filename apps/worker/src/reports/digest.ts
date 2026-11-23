import type { Logger } from "@valtrexia/core/server";
import {
  loadClientMonthReport,
  queueMonthlyReportNotifications,
  type Db,
  type LoadedClientReport,
} from "@valtrexia/db";

/** The first days of a month in which last month's summary is sent. After that it is skipped. */
export const DIGEST_WINDOW_DAYS = 7;

export interface DigestResult {
  /** Workspaces whose summary was queued now. */
  tenants: number;
  /** Messages queued, one per channel. */
  messages: number;
  /** Workspaces whose summary could not be built; tried again at the next run. */
  failed: number;
}

/**
 * Queues the monthly summary for every workspace that is due one: early in
 * the month, in its own time zone, for the month before. Each client's report
 * is built in its own short transaction; the summary is then queued, and the
 * month recorded, in one more. A workspace that fails is left for the next
 * run and does not stop the others.
 */
export async function queueMonthlyDigests(
  deps: { db: Db; logger: Logger; now?: () => Date },
  options: {
    /** For tests: only these workspaces, so a shared database's others are left alone. */
    onlyTenants?: ReadonlySet<string>;
  } = {},
): Promise<DigestResult> {
  const now = (deps.now ?? (() => new Date()))();
  const listed = await deps.db.listReportDigestTenants({ now, windowDays: DIGEST_WINDOW_DAYS });
  const due = options.onlyTenants
    ? listed.filter(({ tenantId }) => options.onlyTenants!.has(tenantId))
    : listed;
  const result: DigestResult = { tenants: 0, messages: 0, failed: 0 };
  for (const { tenantId, month } of due) {
    try {
      const clientIds = await deps.db.withTenant(tenantId, ({ tx }) =>
        tx.client.findMany({ select: { id: true }, orderBy: { name: "asc" } }),
      );
      const reports: LoadedClientReport[] = [];
      for (const { id } of clientIds) {
        const loaded = await deps.db.withTenant(tenantId, (context) =>
          loadClientMonthReport(context, { clientId: id, month, now }),
        );
        if (loaded) reports.push(loaded);
      }
      const messages = await deps.db.withTenant(tenantId, (context) =>
        queueMonthlyReportNotifications(context, { month, now, reports }),
      );
      if (messages === null) continue;
      result.tenants += 1;
      result.messages += messages;
      deps.logger.info({ tenantId, month, messages }, "monthly summary queued");
    } catch (error) {
      result.failed += 1;
      deps.logger.warn(
        { tenantId, month, errorName: error instanceof Error ? error.name : "unknown" },
        "monthly summary failed",
      );
    }
  }
  return result;
}
