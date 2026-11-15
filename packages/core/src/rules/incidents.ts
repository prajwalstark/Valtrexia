import type { BackupStatus } from "../status";
import { isCompletedBackup } from "../status";
import type { MissedBackupVerdict } from "./missed-backup";

/**
 * Incident types raised in Phase 1. `stale` exists in the database enum for
 * the SLA rule and is not raised yet.
 */
export const RAISED_INCIDENT_TYPES = ["failed", "missed"] as const;
export type RaisedIncidentType = (typeof RAISED_INCIDENT_TYPES)[number];

export interface IncidentInput {
  /** The asset's most recent result, as the vendor reported it. Null if it has none. */
  lastResultStatus: BackupStatus | null;
  /** What the missed-backup rule concluded in this sync. */
  verdict: MissedBackupVerdict;
  /** Types that already have an open incident for this asset. */
  open: ReadonlySet<RaisedIncidentType>;
}

export interface IncidentPlan {
  /** Types to open an incident for. Never one that is already open. */
  open: RaisedIncidentType[];
  /** Types whose open incident should be closed. Only ones that are open. */
  close: RaisedIncidentType[];
}

type Action = "open" | "close" | "leave";

/**
 * Decides which incidents to open and close for one asset after a sync.
 *
 * An incident is a problem that stays open until it resolves, so that a
 * technician sees one item per problem rather than one per failed attempt.
 *
 * `missed` follows the missed-backup verdict:
 *   missed -> open; ok -> close; suppressed -> close; indeterminate -> leave.
 *
 * `failed` follows the latest result:
 *   failed -> open
 *   success or warning -> close (a backup has completed since)
 *   running, unknown or no result -> leave: a retry in progress, or a status
 *     we cannot read, is not evidence that the failure is over
 *   and an asset that is archived, paused or muted has its incident closed,
 *     whatever its last result, because it is not being watched.
 *
 * The two are independent. An asset whose backups fail for days has both: the
 * latest attempt failed, and no backup has completed in time.
 */
export function planIncidents(input: IncidentInput): IncidentPlan {
  const suppressed = input.verdict.state === "suppressed";

  const missed: Action =
    input.verdict.state === "missed"
      ? "open"
      : input.verdict.state === "indeterminate"
        ? "leave"
        : "close";

  let failed: Action;
  if (suppressed) failed = "close";
  else if (input.lastResultStatus === "failed") failed = "open";
  else if (input.lastResultStatus !== null && isCompletedBackup(input.lastResultStatus)) {
    failed = "close";
  } else failed = "leave";

  const plan: IncidentPlan = { open: [], close: [] };
  for (const [type, action] of [
    ["failed", failed],
    ["missed", missed],
  ] as const) {
    const isOpen = input.open.has(type);
    if (action === "open" && !isOpen) plan.open.push(type);
    if (action === "close" && isOpen) plan.close.push(type);
  }
  return plan;
}
