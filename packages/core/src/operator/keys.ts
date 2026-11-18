/**
 * Where the worker leaves its signs of life in Redis, read by its own health
 * check and by the web app's status endpoint. Ids and times only.
 */

/** Every key this application writes to Redis starts with this. */
export const REDIS_PREFIX = "valtrexia";

/** How often a running worker says it is alive. */
export const HEARTBEAT_INTERVAL_MS = 30_000;
/** A heartbeat older than this means its worker is not healthy: it missed three beats. */
export const HEARTBEAT_STALE_MS = 3 * HEARTBEAT_INTERVAL_MS;

export interface Heartbeat {
  /** When this beat was written, in milliseconds since the epoch. */
  at: number;
  startedAt: number;
}

export function heartbeatKey(instanceId: string, prefix = REDIS_PREFIX): string {
  return `${prefix}:heartbeat:worker:${instanceId}`;
}

/** A pattern matching every worker's heartbeat, for SCAN. */
export function heartbeatKeyPattern(prefix = REDIS_PREFIX): string {
  return `${prefix}:heartbeat:worker:*`;
}

/** The latest fleet check's numbers. */
export function fleetSnapshotKey(prefix = REDIS_PREFIX): string {
  return `${prefix}:status:fleet`;
}

/** Whether the last maintenance run succeeded. */
export function maintenanceStatusKey(prefix = REDIS_PREFIX): string {
  return `${prefix}:status:maintenance`;
}

/** A stored heartbeat's time, or null if it is missing or unreadable. */
export function heartbeatAt(stored: string | null): number | null {
  if (!stored) return null;
  try {
    const { at } = JSON.parse(stored) as Partial<Heartbeat>;
    return typeof at === "number" && Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

/** Whether a stored heartbeat is recent enough to call its worker healthy. */
export function isHeartbeatFresh(stored: string | null, now: number): boolean {
  const at = heartbeatAt(stored);
  return at !== null && now - at >= -5_000 && now - at < HEARTBEAT_STALE_MS;
}
