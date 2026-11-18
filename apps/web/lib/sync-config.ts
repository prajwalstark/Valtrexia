import { SYNC_INTERVAL_MINUTES } from "@valtrexia/core";

/**
 * How often integrations are synced, from the same `SYNC_INTERVAL_MINUTES`
 * variable the worker reads. The web app needs it to decide when data is too
 * old to trust: the two processes must be given the same value.
 *
 * Fails on a value the worker would also refuse, rather than quietly judging
 * freshness by a different interval than the one syncs actually run at.
 */
export function syncIntervalMinutes(env: Record<string, string | undefined> = process.env): number {
  const raw = env.SYNC_INTERVAL_MINUTES?.trim();
  if (!raw) return SYNC_INTERVAL_MINUTES;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 24 * 60) {
    throw new Error("SYNC_INTERVAL_MINUTES must be a whole number of minutes from 1 to 1440.");
  }
  return value;
}
