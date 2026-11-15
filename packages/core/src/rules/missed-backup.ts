import type { BackupStatus } from "../status";
import { worstStatus } from "../status";

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** A sync is trusted for this many sync intervals after it last succeeded. */
export const STALE_SYNC_AFTER_INTERVALS = 3;

export interface MissedBackupInput {
  now: Date;
  asset: {
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

export type MissedBackupVerdict =
  /** No completed backup inside the allowed window. Open an incident. */
  | { state: "missed"; deadline: Date; hoursOverdue: number }
  /** A completed backup exists inside the window. Close any open incident. */
  | { state: "ok"; deadline: Date }
  /** The asset is deliberately not being watched. Close any open incident. */
  | { state: "suppressed"; reason: "archived" | "paused" | "muted" }
  /**
   * We cannot tell. The vendor data is missing or out of date, so the absence
   * of a backup proves nothing. Leave any open incident exactly as it is.
   */
  | { state: "indeterminate"; reason: "never_synced" | "sync_failing" | "sync_stale" };

/**
 * Decides whether an asset has missed a backup.
 *
 * An asset is missed when its last completed backup, or its discovery if it
 * has never had one, is more than `expectedFrequencyHours + graceHours` ago.
 *
 * Two things take precedence over that arithmetic. An asset that is archived,
 * paused or muted is not judged at all. And if the integration's own sync is
 * failing or out of date, the verdict is "indeterminate" rather than "missed":
 * otherwise a vendor outage would raise a missed-backup incident on every
 * asset that vendor protects.
 */
export function evaluateMissedBackup(input: MissedBackupInput): MissedBackupVerdict {
  const { now, asset, graceHours, integration, syncIntervalMinutes } = input;

  if (!(asset.expectedFrequencyHours > 0) || !Number.isFinite(asset.expectedFrequencyHours)) {
    throw new RangeError("expectedFrequencyHours must be a positive number");
  }
  if (!(graceHours >= 0) || !Number.isFinite(graceHours)) {
    throw new RangeError("graceHours must be zero or a positive number");
  }
  if (!(syncIntervalMinutes > 0) || !Number.isFinite(syncIntervalMinutes)) {
    throw new RangeError("syncIntervalMinutes must be a positive number");
  }

  if (asset.isArchived) return { state: "suppressed", reason: "archived" };
  if (asset.isPaused) return { state: "suppressed", reason: "paused" };
  if (asset.mutedUntil && asset.mutedUntil.getTime() > now.getTime()) {
    return { state: "suppressed", reason: "muted" };
  }

  if (integration.lastSyncAt === null) return { state: "indeterminate", reason: "never_synced" };
  if (integration.syncStatus === "error") return { state: "indeterminate", reason: "sync_failing" };
  const staleAfterMs = STALE_SYNC_AFTER_INTERVALS * syncIntervalMinutes * MINUTE_MS;
  if (now.getTime() - integration.lastSyncAt.getTime() > staleAfterMs) {
    return { state: "indeterminate", reason: "sync_stale" };
  }

  const reference = asset.lastCompletedAt ?? asset.firstSeenAt;
  const deadline = new Date(
    reference.getTime() + (asset.expectedFrequencyHours + graceHours) * HOUR_MS,
  );

  const overdueMs = now.getTime() - deadline.getTime();
  if (overdueMs > 0) {
    return { state: "missed", deadline, hoursOverdue: overdueMs / HOUR_MS };
  }
  return { state: "ok", deadline };
}

/**
 * An asset's current status: the worse of its latest result and a missed
 * verdict. An asset with no results and no missed verdict is `unknown`.
 *
 * When the verdict is not "missed", a previous `missed` status is dropped in
 * favour of the latest result; the caller decides separately whether to keep
 * an incident open (see the "indeterminate" verdict).
 */
export function deriveCurrentStatus(
  latestResultStatus: BackupStatus | null,
  verdict: MissedBackupVerdict,
): BackupStatus {
  const latest: BackupStatus = latestResultStatus ?? "unknown";
  if (verdict.state !== "missed") return latest;
  return worstStatus([latest, "missed"]) ?? "missed";
}
