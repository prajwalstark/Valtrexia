import type { BackupStatus } from "../status";
import { isCompletedBackup } from "../status";
import type { MissedBackupVerdict } from "./missed-backup";
import type { SlaVerdict } from "./sla";

/** Every incident type, in the order they are planned and listed. */
export const RAISED_INCIDENT_TYPES = ["failed", "missed", "stale"] as const;
export type RaisedIncidentType = (typeof RAISED_INCIDENT_TYPES)[number];

export interface IncidentInput {
  /** The asset's most recent result, as the vendor reported it. Null if it has none. */
  lastResultStatus: BackupStatus | null;
  /** What the missed-backup rule concluded in this sync. */
  verdict: MissedBackupVerdict;
  /** What the SLA rule concluded in this sync. */
  sla: SlaVerdict;
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
 *   missed -> open; ok -> close; suppressed -> close;
 *   indeterminate or unconfirmed -> leave: we could not look, so nothing has
 *     been learned either way.
 *
 * `failed` follows the latest result:
 *   failed -> open
 *   success or warning -> close (a backup has completed since)
 *   running, unknown or no result -> leave: a retry in progress, or a status
 *     we cannot read, is not evidence that the failure is over
 *   and an asset that is archived, paused or muted has its incident closed,
 *     whatever its last result, because it is not being watched.
 *
 * `stale` follows the SLA verdict:
 *   breached -> open; ok -> close; suppressed -> close; indeterminate -> leave.
 *
 * The three are independent. An asset whose backups fail for days has all of
 * them: the latest attempt failed, no backup completed in time, and it has
 * now been without one for longer than its SLA. Each closes for its own
 * reason, though a completed backup closes all three at once.
 */
export function planIncidents(input: IncidentInput): IncidentPlan {
  const suppressed = input.verdict.state === "suppressed";

  const missed: Action =
    input.verdict.state === "missed"
      ? "open"
      : input.verdict.state === "indeterminate" || input.verdict.state === "unconfirmed"
        ? "leave"
        : "close";

  let failed: Action;
  if (suppressed) failed = "close";
  else if (input.lastResultStatus === "failed") failed = "open";
  else if (input.lastResultStatus !== null && isCompletedBackup(input.lastResultStatus)) {
    failed = "close";
  } else failed = "leave";

  const stale: Action =
    input.sla.state === "breached"
      ? "open"
      : input.sla.state === "indeterminate"
        ? "leave"
        : "close";

  const plan: IncidentPlan = { open: [], close: [] };
  for (const [type, action] of [
    ["failed", failed],
    ["missed", missed],
    ["stale", stale],
  ] as const) {
    const isOpen = input.open.has(type);
    if (action === "open" && !isOpen) plan.open.push(type);
    if (action === "close" && isOpen) plan.close.push(type);
  }
  return plan;
}
