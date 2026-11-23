import { isMutedIndefinitely } from "../asset-settings";
import { daysOfMonth, dayKey, startOfDay, shiftMonth } from "../format";
import type { RaisedIncidentType } from "../rules/incidents";
import { effectiveSlaHours } from "../rules/sla";
import { isCompletedBackup, worstStatus, type BackupStatus } from "../status";

/**
 * One client's backups over one calendar month, in the workspace's time
 * zone: what the monthly report shows. Pure, so every figure is tested.
 *
 * Each day is judged at its end (or now, for today) by the same rules the
 * dashboard uses: *on schedule* if the last completed backup is within the
 * asset's expected interval plus grace, *within SLA* if it is within the
 * asset's SLA. Judging days this way scores a weekly asset by its own
 * schedule, not by how many days it happened to back up.
 */

const HOUR_MS = 3_600_000;

export interface ReportAsset {
  id: string;
  name: string;
  type: string;
  deviceName: string | null;
  expectedFrequencyHours: number;
  slaHours: number;
  firstSeenAt: Date;
  isPaused: boolean;
  isArchived: boolean;
  mutedUntil: Date | null;
}

export interface ReportResult {
  assetId: string;
  startedAt: Date;
  endedAt: Date | null;
  status: BackupStatus;
}

export interface ReportIncident {
  assetId: string;
  type: RaisedIncidentType;
  openedAt: Date;
  closedAt: Date | null;
}

export interface ClientMonthInput {
  /** YYYY-MM. */
  month: string;
  timeZone: string;
  graceHours: number;
  now: Date;
  assets: ReportAsset[];
  /** Results that started in the month, or up to two days before it. */
  results: ReportResult[];
  /**
   * When each asset's latest completed backup finished, among those that
   * started before the results above. Normally before the month; a very long
   * backup can finish inside it, and is judged from when it did.
   */
  lastCompletedBefore: ReadonlyMap<string, Date>;
  /** Incidents opened or closed in the month. */
  incidents: ReportIncident[];
}

/** One day's cell in an asset's strip. */
export interface ReportDay {
  date: string;
  /** The worst result that started that day, or null if none did. */
  worst: BackupStatus | null;
  onSchedule: boolean;
  withinSla: boolean;
}

export interface AssetMonth {
  id: string;
  name: string;
  type: string;
  deviceName: string | null;
  /** Days counted: from the first day it was known, to the month's end or today. */
  days: ReportDay[];
  /** Shares of those days, 0 to 1. */
  onSchedule: number;
  withinSla: number;
  backups: { completed: number; failed: number };
}

export interface ClientMonthReport {
  month: string;
  /** True for the month still in progress: figures run to today. */
  partial: boolean;
  /** Every day of the month that has begun, in order. */
  days: string[];
  /** Counted assets, worst first. */
  assets: AssetMonth[];
  /** Assets left out of the figures, and why. */
  excluded: { name: string; reason: "paused" | "archived" | "muted" }[];
  summary: {
    assets: number;
    /** Averages over counted assets, 0 to 1; null with no counted asset. */
    onSchedule: number | null;
    withinSla: number | null;
    backups: { completed: number; failed: number };
  };
  incidents: {
    opened: Record<RaisedIncidentType, number>;
    closed: Record<RaisedIncidentType, number>;
    /** Median hours from opening to closing, for those closed this month. */
    medianHoursToClose: number | null;
  };
}

const NO_INCIDENTS = (): Record<RaisedIncidentType, number> => ({ failed: 0, missed: 0, stale: 0 });

export function buildClientMonthReport(input: ClientMonthInput): ClientMonthReport {
  const { month, timeZone, graceHours, now } = input;
  const monthStart = startOfDay(`${month}-01`, timeZone);
  const monthEnd = startOfDay(`${shiftMonth(month, 1)}-01`, timeZone);
  const today = dayKey(now, timeZone);
  const partial = now < monthEnd;
  const days = daysOfMonth(month).filter((key) => key <= today);

  // Where each day ends, as an instant: the next day's start, or now for today.
  const dayEnds = days.map((key, index) => {
    const next = index + 1 < days.length ? startOfDay(days[index + 1]!, timeZone) : monthEnd;
    return next > now ? now : next;
  });

  const excluded: ClientMonthReport["excluded"] = [];
  const counted: AssetMonth[] = [];
  for (const asset of input.assets) {
    if (asset.firstSeenAt >= monthEnd) continue;
    if (asset.isArchived) {
      excluded.push({ name: asset.name, reason: "archived" });
      continue;
    }
    if (asset.isPaused) {
      excluded.push({ name: asset.name, reason: "paused" });
      continue;
    }
    if (isMutedIndefinitely(asset.mutedUntil)) {
      excluded.push({ name: asset.name, reason: "muted" });
      continue;
    }
    counted.push(
      assetMonth(asset, input, days, dayEnds, monthStart, monthEnd, graceHours, timeZone),
    );
  }
  counted.sort(
    (a, b) =>
      a.onSchedule - b.onSchedule ||
      a.withinSla - b.withinSla ||
      a.name.localeCompare(b.name, "en"),
  );

  const opened = NO_INCIDENTS();
  const closed = NO_INCIDENTS();
  const hoursToClose: number[] = [];
  const countedIds = new Set(counted.map((asset) => asset.id));
  for (const incident of input.incidents) {
    if (!countedIds.has(incident.assetId)) continue;
    if (incident.openedAt >= monthStart && incident.openedAt < monthEnd) opened[incident.type] += 1;
    if (incident.closedAt && incident.closedAt >= monthStart && incident.closedAt < monthEnd) {
      closed[incident.type] += 1;
      hoursToClose.push((incident.closedAt.getTime() - incident.openedAt.getTime()) / HOUR_MS);
    }
  }

  const average = (pick: (asset: AssetMonth) => number) =>
    counted.length === 0
      ? null
      : counted.reduce((sum, asset) => sum + pick(asset), 0) / counted.length;
  return {
    month,
    partial,
    days,
    assets: counted,
    excluded: excluded.sort((a, b) => a.name.localeCompare(b.name, "en")),
    summary: {
      assets: counted.length,
      onSchedule: average((asset) => asset.onSchedule),
      withinSla: average((asset) => asset.withinSla),
      backups: {
        completed: counted.reduce((sum, asset) => sum + asset.backups.completed, 0),
        failed: counted.reduce((sum, asset) => sum + asset.backups.failed, 0),
      },
    },
    incidents: { opened, closed, medianHoursToClose: median(hoursToClose) },
  };
}

function assetMonth(
  asset: ReportAsset,
  input: ClientMonthInput,
  days: string[],
  dayEnds: Date[],
  monthStart: Date,
  monthEnd: Date,
  graceHours: number,
  timeZone: string,
): AssetMonth {
  const results = input.results.filter((result) => result.assetId === asset.id);
  // When each completed backup finished, oldest first.
  const earlier = input.lastCompletedBefore.get(asset.id);
  const completions = results
    .filter((result) => isCompletedBackup(result.status))
    .map((result) => (result.endedAt ?? result.startedAt).getTime())
    .concat(earlier ? [earlier.getTime()] : [])
    .sort((a, b) => a - b);
  const scheduleMs = (asset.expectedFrequencyHours + graceHours) * HOUR_MS;
  const slaMs = effectiveSlaHours(asset, graceHours) * HOUR_MS;
  const firstDay = dayKey(asset.firstSeenAt, timeZone);

  let last: number | null = null;
  let next = 0;
  const cells: ReportDay[] = [];
  days.forEach((key, index) => {
    const end = dayEnds[index]!.getTime();
    while (next < completions.length && completions[next]! <= end) {
      last = completions[next]!;
      next += 1;
    }
    if (key < firstDay) return;
    // As the rules do: an asset never backed up is judged from when it was first seen.
    const reference = last ?? asset.firstSeenAt.getTime();
    const started = results.filter((result) => dayKey(result.startedAt, timeZone) === key);
    cells.push({
      date: key,
      worst: worstStatus(started.map((result) => result.status)),
      onSchedule: end - reference <= scheduleMs,
      withinSla: end - reference <= slaMs,
    });
  });

  const inMonth = results.filter(
    (result) => result.startedAt >= monthStart && result.startedAt < monthEnd,
  );
  const share = (pick: (day: ReportDay) => boolean) =>
    cells.length === 0 ? 1 : cells.filter(pick).length / cells.length;
  return {
    id: asset.id,
    name: asset.name,
    type: asset.type,
    deviceName: asset.deviceName,
    days: cells,
    onSchedule: share((day) => day.onSchedule),
    withinSla: share((day) => day.withinSla),
    backups: {
      completed: inMonth.filter((result) => isCompletedBackup(result.status)).length,
      failed: inMonth.filter((result) => result.status === "failed").length,
    },
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
