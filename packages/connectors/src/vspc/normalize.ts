import type { NormalizedStatus } from "../types";

/**
 * Veeam's status values, from the specification, onto ours. Both lists are
 * marked extensible by Veeam; anything not listed is "unknown", never a guess.
 * Maps, not object literals, so a value such as "toString" finds nothing.
 */

/** `lastSession.backupStatus` of a VM in a backup job: Unknown, Running, Success, Warning, Failed. */
const VM_SESSION = new Map<string, NormalizedStatus>([
  ["Success", "success"],
  ["Warning", "warning"],
  ["Failed", "failed"],
  ["Running", "running"],
]);

/** `status` of a backup agent job: Unknown, None, Success, Warning, Failed, Starting, Running, Stopping. */
const AGENT_JOB = new Map<string, NormalizedStatus>([
  ["Success", "success"],
  ["Warning", "warning"],
  ["Failed", "failed"],
  ["Starting", "running"],
  ["Running", "running"],
  // Being stopped by someone: the outcome is not known until it has stopped.
  ["Stopping", "running"],
]);

/**
 * The status of one stored result. A VM result's record is a backup job
 * object, which has `lastSession`; an agent result's record is a backup agent
 * job, which has `status`. Pure and total: never throws.
 */
export function normalizeVspcStatus(raw: unknown): NormalizedStatus {
  if (raw === null || typeof raw !== "object") return "unknown";
  const record = raw as { lastSession?: unknown; status?: unknown };
  if (record.lastSession && typeof record.lastSession === "object") {
    const value = (record.lastSession as { backupStatus?: unknown }).backupStatus;
    return (typeof value === "string" && VM_SESSION.get(value)) || "unknown";
  }
  return (typeof record.status === "string" && AGENT_JOB.get(record.status)) || "unknown";
}

/**
 * How often a job is expected to run, from its schedule type, when that says
 * it plainly. Only "Daily" does: a periodic schedule's interval is in a field
 * that VSPC 8.1 does not return, and "Monthly", "Continuously", "BackupWindow"
 * and "Chained" do not map to a fixed number of hours.
 */
export function frequencyOfSchedule(scheduleType: string | null | undefined): number | null {
  return scheduleType === "Daily" ? 24 : null;
}

/** The text worth showing from a VM session's messages: the failure, if any, in a single line. */
export function sessionMessage(messages: readonly string[] | null | undefined): string | null {
  const text = (messages ?? [])
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ");
  return text ? text.slice(0, 500) : null;
}
