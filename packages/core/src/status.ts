/**
 * Normalized backup status. Every vendor's own status vocabulary is mapped
 * onto these six values by its connector.
 *
 * `missed` is different from the rest: no vendor attempt produced it. It is
 * derived by the missed-backup rule when an expected backup did not happen.
 */
export const BACKUP_STATUSES = [
  "success",
  "warning",
  "failed",
  "missed",
  "running",
  "unknown",
] as const;

export type BackupStatus = (typeof BACKUP_STATUSES)[number];

export function isBackupStatus(value: unknown): value is BackupStatus {
  return typeof value === "string" && (BACKUP_STATUSES as readonly string[]).includes(value);
}

/**
 * How bad a status is, highest first. Used to pick the worst of several
 * statuses, for example the worst result of a day.
 *
 * `unknown` ranks above `running` and `success` on purpose: a status we could
 * not interpret must be looked at, not assumed fine.
 */
const SEVERITY: Record<BackupStatus, number> = {
  failed: 5,
  missed: 4,
  warning: 3,
  unknown: 2,
  running: 1,
  success: 0,
};

export function statusSeverity(status: BackupStatus): number {
  return SEVERITY[status];
}

/** The most severe of the given statuses, or null when there are none. */
export function worstStatus(statuses: Iterable<BackupStatus>): BackupStatus | null {
  let worst: BackupStatus | null = null;
  for (const status of statuses) {
    if (worst === null || SEVERITY[status] > SEVERITY[worst]) worst = status;
  }
  return worst;
}

/**
 * Whether a result means a backup was actually taken.
 *
 * A warning counts: for example, a Datto backup that succeeded but failed
 * screenshot verification still produced a restore point. It needs attention,
 * but the backup was not missed.
 */
export function isCompletedBackup(status: BackupStatus): boolean {
  return status === "success" || status === "warning";
}

export interface ResultTiming {
  status: BackupStatus;
  startedAt: Date;
  endedAt: Date | null;
}

/**
 * When the most recent completed backup finished, or null if there has never
 * been one. This is the value stored as an asset's `lastSuccessAt`.
 */
export function lastCompletedBackupAt(results: Iterable<ResultTiming>): Date | null {
  let latest: Date | null = null;
  for (const result of results) {
    if (!isCompletedBackup(result.status)) continue;
    const at = result.endedAt ?? result.startedAt;
    if (latest === null || at.getTime() > latest.getTime()) latest = at;
  }
  return latest;
}
