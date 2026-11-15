import type { BackupStatus, ClientHealth } from "@valtrexia/core";
import { count } from "./format";

/** Statuses in the order they are always listed and drawn: worst first. */
export const STATUS_ORDER: readonly BackupStatus[] = [
  "failed",
  "missed",
  "warning",
  "unknown",
  "running",
  "success",
];

const NOUN: Record<BackupStatus, string> = {
  failed: "failed",
  missed: "missed",
  warning: "with warnings",
  unknown: "unknown",
  running: "running",
  success: "backed up",
};

/**
 * One line on the state of a client's backups, for the dashboard list.
 * It names what is wrong and how much of the client that is.
 */
export function describeClient(summary: ClientHealth): string {
  const { counts, watched, excluded, health } = summary;

  if (health === "none") {
    return excluded > 0
      ? `${count(excluded, "asset")}, none being watched`
      : "No protected assets found yet";
  }

  if (health === "green") {
    return counts.running > 0
      ? `${counts.success} backed up, ${counts.running} running`
      : watched === 1
        ? "Its 1 asset is backed up"
        : `All ${watched} assets backed up`;
  }

  const wrong = (
    health === "red" ? ["failed", "missed"] : ["warning", "unknown"]
  ) as BackupStatus[];
  const parts = wrong.filter((status) => counts[status] > 0).map((s) => `${counts[s]} ${NOUN[s]}`);
  // Amber with nothing wrong on any asset: the vendor sync itself is failing.
  if (parts.length === 0) return `Vendor sync failing; ${count(watched, "asset")} not confirmed`;
  return `${parts.join(", ")} of ${count(watched, "asset")}`;
}
