import type { BackupStatus, ClientMonthReport, ReportDay } from "@valtrexia/core";
import { loadClientMonthReport, type Db } from "@valtrexia/db";
import { z } from "zod";
import { isMonthKey, monthKey, shiftMonth } from "./format";
import type { TenantSession } from "./session-core";

/**
 * Backup results are kept for 13 months (README, "Data retention"), so a
 * report reaches back twelve full months before the current one.
 */
export const REPORT_MONTHS_BACK = 12;

export interface ClientReportPage {
  client: { id: string; name: string };
  timeZone: string;
  month: string;
  /** The neighbouring months a report can be shown for; null at either end. */
  previous: string | null;
  next: string | null;
  report: ClientMonthReport;
}

/**
 * The month to show: the one asked for, if it is a month a report covers;
 * otherwise the last full month, which is what a report is normally for.
 */
export function reportMonth(asked: string | undefined, now: Date, timeZone: string): string {
  const current = monthKey(now, timeZone);
  const earliest = shiftMonth(current, -REPORT_MONTHS_BACK);
  if (asked && isMonthKey(asked) && asked >= earliest && asked <= current) return asked;
  return shiftMonth(current, -1);
}

/**
 * A client's report for a month. Null for an id that is malformed, does not
 * exist, or belongs to another tenant, without saying which.
 */
export async function getClientReport(
  deps: { db: Db },
  session: TenantSession,
  clientId: string,
  askedMonth: string | undefined,
  now: Date,
): Promise<ClientReportPage | null> {
  if (!z.uuid().safeParse(clientId).success) return null;
  return deps.db.withTenant(session.tenantId, async (context) => {
    const { timeZone } = await context.tx.tenant.findUniqueOrThrow({
      where: { id: session.tenantId },
      select: { timeZone: true },
    });
    const month = reportMonth(askedMonth, now, timeZone);
    const loaded = await loadClientMonthReport(context, { clientId, month, now });
    if (!loaded) return null;
    const current = monthKey(now, timeZone);
    const previous = shiftMonth(month, -1);
    const next = shiftMonth(month, 1);
    return {
      ...loaded,
      month,
      previous: previous >= shiftMonth(current, -REPORT_MONTHS_BACK) ? previous : null,
      next: next <= current ? next : null,
    };
  });
}

/**
 * What a day's cell shows: the day's worst result; or, on a day with none,
 * "overdue" if the asset was behind schedule and nothing if no backup was due.
 */
export type ReportCell = BackupStatus | "overdue" | null;

export function cellStatus(day: ReportDay): ReportCell {
  if (day.worst) return day.worst;
  return day.onSchedule ? null : "overdue";
}
