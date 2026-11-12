import type { BackupStatus } from "./status";

/**
 * A client's overall state on the dashboard.
 *
 * - `red`: at least one watched asset has failed or missed a backup.
 * - `amber`: nothing red, but something needs a look: a warning, a status we
 *   could not interpret, or a vendor sync that is failing.
 * - `green`: every watched asset is backing up.
 * - `none`: the client has no watched assets, so there is nothing to judge.
 */
export const HEALTH_LEVELS = ["red", "amber", "green", "none"] as const;
export type Health = (typeof HEALTH_LEVELS)[number];

export interface HealthAsset {
  currentStatus: BackupStatus;
  mutedUntil: Date | null;
  isPaused: boolean;
  isArchived: boolean;
}

export interface ClientHealth {
  health: Health;
  /** Watched assets by current status. */
  counts: Record<BackupStatus, number>;
  /** Assets counted towards health. */
  watched: number;
  /** Assets left out because they are muted, paused or archived. */
  excluded: number;
  /** Assets responsible for the health level: failed + missed, or warning + unknown. */
  affected: number;
}

/** Whether an asset counts towards health right now. */
export function isWatched(asset: HealthAsset, now: Date): boolean {
  if (asset.isArchived || asset.isPaused) return false;
  return !(asset.mutedUntil && asset.mutedUntil.getTime() > now.getTime());
}

export function summarizeClientHealth(
  assets: Iterable<HealthAsset>,
  options: {
    now: Date;
    /** True when any integration feeding this client is failing to sync. */
    syncFailing?: boolean;
  },
): ClientHealth {
  const counts: Record<BackupStatus, number> = {
    success: 0,
    warning: 0,
    failed: 0,
    missed: 0,
    running: 0,
    unknown: 0,
  };
  let watched = 0;
  let excluded = 0;

  for (const asset of assets) {
    if (!isWatched(asset, options.now)) {
      excluded += 1;
      continue;
    }
    watched += 1;
    counts[asset.currentStatus] += 1;
  }

  const critical = counts.failed + counts.missed;
  const attention = counts.warning + counts.unknown;

  let health: Health;
  let affected: number;
  if (critical > 0) {
    health = "red";
    affected = critical;
  } else if (attention > 0 || (options.syncFailing === true && watched > 0)) {
    health = "amber";
    affected = attention;
  } else if (watched > 0) {
    health = "green";
    affected = 0;
  } else {
    health = "none";
    affected = 0;
  }

  return { health, counts, watched, excluded, affected };
}

const HEALTH_ORDER: Record<Health, number> = { red: 0, amber: 1, green: 2, none: 3 };

/**
 * Sort order for the dashboard: worst first, then by how many assets are
 * affected, then by name so the order is stable.
 */
export function compareWorstFirst(
  a: { name: string; summary: ClientHealth },
  b: { name: string; summary: ClientHealth },
): number {
  return (
    HEALTH_ORDER[a.summary.health] - HEALTH_ORDER[b.summary.health] ||
    b.summary.affected - a.summary.affected ||
    a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" })
  );
}
