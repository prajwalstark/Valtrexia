import type { NormalizedStatus } from "../types";
import { dattoBackupSchema, type DattoBackup } from "./schema";

// The exact strings Datto uses are unverified (see schema.ts). Each set lists
// every spelling that would plausibly mean the same thing, so a small
// difference from our guess still maps correctly. Anything outside these sets
// becomes "unknown", which shows up amber on the dashboard and gets noticed.
const SUCCEEDED = new Set(["success", "successful", "succeeded", "ok", "completed", "complete"]);
const FAILED = new Set(["failure", "failed", "fail", "error", "errored"]);
const RUNNING = new Set([
  "running",
  "in_progress",
  "inprogress",
  "in progress",
  "started",
  "pending",
  "queued",
]);
const WARNED = new Set(["warning", "warnings", "partial", "completed_with_warnings"]);

const token = (value: unknown): string =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

/** How a verification step turned out. `not_attempted` covers absent, null and unrecognized. */
export type Verification = "passed" | "failed" | "not_attempted";

export function verificationOutcome(status: unknown): Verification {
  if (status === true) return "passed";
  if (status === false) return "failed";
  const value = token(status);
  if (SUCCEEDED.has(value) || value === "passed" || value === "pass") return "passed";
  if (FAILED.has(value)) return "failed";
  return "not_attempted";
}

export function screenshotOutcome(backup: DattoBackup): Verification {
  return verificationOutcome(backup.advancedVerification?.screenshotVerification?.status);
}

/** Local verification fails on a failed status or on any reported error. */
export function localVerificationOutcome(backup: DattoBackup): Verification {
  const local = backup.localVerification;
  if (!local) return "not_attempted";
  if ((local.errors?.length ?? 0) > 0) return "failed";
  return verificationOutcome(local.status);
}

/**
 * Maps one entry of a Datto asset's `backups[]` to a normalized status.
 *
 *   backup failed                                   -> failed
 *   backup succeeded, a verification failed         -> warning
 *   backup succeeded, verification passed or absent -> success
 *   backup still in progress                        -> running
 *   anything else                                   -> unknown
 *
 * A backup that succeeded but failed screenshot or local verification is a
 * warning rather than a failure: the restore point exists, so the backup was
 * not missed, but nobody has shown it will boot. It needs a person to look.
 *
 * Total and pure: never throws, whatever it is given.
 */
export function normalizeDattoStatus(raw: unknown): NormalizedStatus {
  const parsed = dattoBackupSchema.safeParse(raw);
  if (!parsed.success) return "unknown";
  const entry = parsed.data;
  const status = token(entry.backup?.status);

  if (FAILED.has(status)) return "failed";
  if (RUNNING.has(status)) return "running";
  if (WARNED.has(status)) return "warning";
  if (SUCCEEDED.has(status)) {
    return screenshotOutcome(entry) === "failed" || localVerificationOutcome(entry) === "failed"
      ? "warning"
      : "success";
  }
  return "unknown";
}

/** The most useful single line about a backup, for display. Null when there is nothing to say. */
export function dattoMessage(backup: DattoBackup): string | null {
  const explicit = backup.backup?.errorMessage?.trim();
  if (explicit) return explicit;

  const localError = backup.localVerification?.errors?.find((e) => e.errorMessage?.trim());
  if (localError?.errorMessage) return `Local verification: ${localError.errorMessage.trim()}`;
  if (localVerificationOutcome(backup) === "failed") return "Local verification failed.";
  if (screenshotOutcome(backup) === "failed") return "Screenshot verification failed.";
  return null;
}
