import type { NormalizedStatus } from "../types";

/**
 * UniView's backup status values, from its specification: Successful,
 * Warning, Failed, InProgress, Unknown. A Map, not an object literal, so a
 * value such as "toString" finds nothing.
 */
const BACKUP = new Map<string, NormalizedStatus>([
  ["Successful", "success"],
  ["Warning", "warning"],
  ["Failed", "failed"],
  ["InProgress", "running"],
]);

/**
 * The status of one stored backup record. Replication status is not part of
 * it: a backup that completed is a completed backup, whether or not its copy
 * reached the replication target. Pure and total: never throws.
 */
export function normalizeUniviewStatus(raw: unknown): NormalizedStatus {
  if (raw === null || typeof raw !== "object") return "unknown";
  const status = (raw as { status?: unknown }).status;
  return (typeof status === "string" && BACKUP.get(status)) || "unknown";
}
