import { vendorDataProblem, watchSuppression } from "./missed-backup";

const HOUR_MS = 60 * 60 * 1000;

export interface SlaInput {
  now: Date;
  asset: {
    /** The longest the asset may go without a completed backup, in hours. */
    slaHours: number;
    /** How often a backup is expected, in hours. */
    expectedFrequencyHours: number;
    /** When the asset was first discovered. The reference point until it has a backup. */
    firstSeenAt: Date;
    /** When the last completed backup (success or warning) finished, if ever. */
    lastCompletedAt: Date | null;
    mutedUntil: Date | null;
    isPaused: boolean;
    isArchived: boolean;
  };
  /** Extra hours allowed past the expected frequency. Set per tenant. */
  graceHours: number;
  integration: {
    syncStatus: "never" | "running" | "ok" | "error";
    /** When data was last pulled from the vendor successfully. */
    lastSyncAt: Date | null;
  };
  /** How often integrations are synced, in minutes. */
  syncIntervalMinutes: number;
}

export type SlaVerdict =
  /** No completed backup for longer than the SLA allows. Open a stale incident. */
  | { state: "breached"; deadline: Date; hoursOverdue: number; effectiveSlaHours: number }
  /** A completed backup exists inside the SLA. Close any open stale incident. */
  | { state: "ok"; deadline: Date; effectiveSlaHours: number }
  /** The asset is deliberately not being watched. Close any open stale incident. */
  | { state: "suppressed"; reason: "archived" | "paused" | "muted" }
  /** The vendor data is missing or out of date. Leave any open incident as it is. */
  | { state: "indeterminate"; reason: "never_synced" | "sync_failing" | "sync_stale" };

/**
 * The SLA actually applied: the configured one, but never shorter than the
 * asset's own backup window.
 *
 * An asset backed up weekly cannot honour a 72-hour SLA, and would be
 * reported stale every week while doing exactly what it is scheduled to do.
 * So a stale backup is always also a missed one: stale is the escalation of
 * missed, never something that fires before it.
 */
export function effectiveSlaHours(
  asset: { slaHours: number; expectedFrequencyHours: number },
  graceHours: number,
): number {
  return Math.max(asset.slaHours, asset.expectedFrequencyHours + graceHours);
}

/**
 * Decides whether an asset has gone too long without a completed backup.
 *
 * This is a different question from the missed-backup rule's. That one asks
 * whether the latest expected backup happened. This one asks how long the
 * asset has now been without any good backup, whatever the reason: attempts
 * that failed every night count the same as attempts that never ran. An asset
 * whose backups fail for three days is "failed" from the first night; it
 * becomes stale when the SLA is crossed.
 *
 * Like the missed-backup rule, it never concludes anything from data that is
 * out of date, and does not judge an asset that is archived, paused or muted.
 */
export function evaluateSla(input: SlaInput): SlaVerdict {
  const { now, asset, graceHours, integration, syncIntervalMinutes } = input;

  if (!(asset.slaHours > 0) || !Number.isFinite(asset.slaHours)) {
    throw new RangeError("slaHours must be a positive number");
  }
  if (!(asset.expectedFrequencyHours > 0) || !Number.isFinite(asset.expectedFrequencyHours)) {
    throw new RangeError("expectedFrequencyHours must be a positive number");
  }
  if (!(graceHours >= 0) || !Number.isFinite(graceHours)) {
    throw new RangeError("graceHours must be zero or a positive number");
  }
  const outOfDate = vendorDataProblem(integration, now, syncIntervalMinutes);

  const suppressed = watchSuppression(asset, now);
  if (suppressed) return { state: "suppressed", reason: suppressed };
  if (outOfDate) return { state: "indeterminate", reason: outOfDate };

  const slaHours = effectiveSlaHours(asset, graceHours);
  const reference = asset.lastCompletedAt ?? asset.firstSeenAt;
  const deadline = new Date(reference.getTime() + slaHours * HOUR_MS);

  const overdueMs = now.getTime() - deadline.getTime();
  if (overdueMs > 0) {
    return {
      state: "breached",
      deadline,
      hoursOverdue: overdueMs / HOUR_MS,
      effectiveSlaHours: slaHours,
    };
  }
  return { state: "ok", deadline, effectiveSlaHours: slaHours };
}
