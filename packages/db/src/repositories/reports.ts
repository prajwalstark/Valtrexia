import {
  buildClientMonthReport,
  RAISED_INCIDENT_TYPES,
  type ClientMonthReport,
  type RaisedIncidentType,
} from "@valtrexia/core";
import { isMonthKey, shiftMonth, startOfDay } from "@valtrexia/core/format";
import type { TenantContext } from "../db";

/**
 * Loads what one client's monthly report needs and builds it. Only named
 * columns are read: no vendor payload, nothing about integrations' keys.
 */

const DAY_MS = 86_400_000;
/**
 * Results are loaded from this long before the month, so a backup that
 * started before it and finished inside it is placed exactly. One that ran
 * longer is still counted, from the latest completion before this window.
 */
const LEAD_DAYS = 2;

export interface LoadedClientReport {
  client: { id: string; name: string };
  timeZone: string;
  report: ClientMonthReport;
}

/** Null for a client that does not exist in this tenant, or a malformed month. */
export async function loadClientMonthReport(
  { tx, tenantId }: TenantContext,
  input: { clientId: string; month: string; now: Date },
): Promise<LoadedClientReport | null> {
  const { clientId, month, now } = input;
  if (!isMonthKey(month)) return null;
  const tenant = await tx.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { graceHours: true, timeZone: true },
  });
  const client = await tx.client.findUnique({
    where: { id: clientId },
    select: {
      id: true,
      name: true,
      assets: {
        select: {
          id: true,
          name: true,
          type: true,
          deviceName: true,
          expectedFrequencyHours: true,
          slaHours: true,
          firstSeenAt: true,
          isPaused: true,
          isArchived: true,
          mutedUntil: true,
        },
      },
    },
  });
  if (!client) return null;

  const timeZone = tenant.timeZone;
  const monthStart = startOfDay(`${month}-01`, timeZone);
  const monthEnd = startOfDay(`${shiftMonth(month, 1)}-01`, timeZone);
  const windowStart = new Date(monthStart.getTime() - LEAD_DAYS * DAY_MS);
  const assetIds = client.assets.map((asset) => asset.id);

  const results = await tx.backupResult.findMany({
    where: { assetId: { in: assetIds }, startedAt: { gte: windowStart, lt: monthEnd } },
    select: { assetId: true, startedAt: true, endedAt: true, status: true },
  });
  // A GROUP BY in the database: one row per asset, however long its history.
  const earlier = await tx.backupResult.groupBy({
    by: ["assetId"],
    where: {
      assetId: { in: assetIds },
      startedAt: { lt: windowStart },
      status: { in: ["success", "warning"] },
    },
    _max: { startedAt: true, endedAt: true },
  });
  const incidents = await tx.incident.findMany({
    where: {
      assetId: { in: assetIds },
      type: { in: [...RAISED_INCIDENT_TYPES] },
      OR: [
        { openedAt: { gte: monthStart, lt: monthEnd } },
        { closedAt: { gte: monthStart, lt: monthEnd } },
      ],
    },
    select: { assetId: true, type: true, openedAt: true, closedAt: true },
  });

  const lastCompletedBefore = new Map<string, Date>();
  for (const row of earlier) {
    // A completion is when a backup ended, or started if no end was reported.
    // The latest is whichever of the two maxima is later.
    const candidates = [row._max.startedAt, row._max.endedAt].filter((d): d is Date => d !== null);
    if (candidates.length === 0) continue;
    lastCompletedBefore.set(row.assetId, new Date(Math.max(...candidates.map((d) => d.getTime()))));
  }

  const report = buildClientMonthReport({
    month,
    timeZone,
    graceHours: tenant.graceHours,
    now,
    assets: client.assets,
    results,
    lastCompletedBefore,
    incidents: incidents.map((incident) => ({
      ...incident,
      type: incident.type as RaisedIncidentType,
    })),
  });
  return { client: { id: client.id, name: client.name }, timeZone, report };
}
