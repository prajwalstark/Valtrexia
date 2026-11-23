import { brand } from "../brand";
import { formatDateTime } from "../format";
import type { IncidentPayloadEntry } from "../notifications/plan";
import type { RaisedIncidentType } from "../rules/incidents";

/**
 * What a PSA ticket says: its subject and each comment. Pure, so the wording
 * is tested. Names and times only, as in every other message; never
 * credentials or a vendor's payload.
 */

const PROBLEM: Record<RaisedIncidentType, string> = {
  failed: "Backup failed",
  missed: "Backup missed",
  stale: "Past its backup SLA",
};

/** A short reference written into the subject, by which a ticket can be found again. */
export function ticketRef(ticketRowId: string): string {
  return ticketRowId.replace(/-/g, "").slice(0, 10);
}

export function refInSubject(ref: string): string {
  return `[ref ${ref}]`;
}

export function ticketSubject(entry: IncidentPayloadEntry, ref: string): string {
  const head = `${PROBLEM[entry.type]}: ${entry.asset.name} (${entry.client.name})`;
  const tail = ` ${refInSubject(ref)}`;
  return `${head.slice(0, 250 - tail.length)}${tail}`.replace(/[\r\n\t]+/g, " ");
}

/**
 * One comment: what happened to the asset in this message, and, when nothing
 * is open any more, that the ticket is being closed.
 */
export function ticketNews(input: {
  opened: readonly IncidentPayloadEntry[];
  closed: readonly IncidentPayloadEntry[];
  /** True when the asset has no open problem left: the ticket is being closed. */
  allClear: boolean;
  resolvedStatus: string;
  timeZone: string;
  appBaseUrl?: string | undefined;
}): { subject: string; body: string } {
  const when = (iso: string | null) => (iso ? formatDateTime(new Date(iso), input.timeZone) : null);
  const lines: string[] = [];
  for (const entry of input.opened) {
    const last = when(entry.lastBackupAt);
    lines.push(
      `${PROBLEM[entry.type]} on ${entry.asset.name}, since ${when(entry.openedAt)!}. ` +
        (last ? `Last good backup ${last}.` : "No good backup on record."),
    );
  }
  for (const entry of input.closed) {
    lines.push(
      entry.reason === "suppressed"
        ? `No longer tracked: ${PROBLEM[entry.type].toLowerCase()} on ${entry.asset.name}. The asset was muted, paused or archived in ${brand.name}.`
        : `Resolved: ${PROBLEM[entry.type].toLowerCase()} on ${entry.asset.name}${entry.closedAt ? `, at ${when(entry.closedAt)!}` : ""}.`,
    );
  }
  const any = input.opened[0] ?? input.closed[0];
  if (input.allClear && any) {
    lines.push(
      `No backup problem on ${any.asset.name} is open now. Setting this ticket to ${input.resolvedStatus}.`,
    );
  }
  if (input.appBaseUrl && any) {
    lines.push(
      `${any.client.name} in ${brand.name}: ${input.appBaseUrl.replace(/\/+$/, "")}/clients/${encodeURIComponent(any.client.id)}`,
    );
  }
  const subject =
    input.opened.length > 0
      ? PROBLEM[input.opened[0]!.type]
      : input.allClear
        ? "Backup problems resolved"
        : "Backup problem resolved";
  return { subject, body: lines.join("\n\n") };
}

/** Statuses that mean a ticket is closed, whatever this channel moves tickets to. */
export function isClosedStatus(status: string, resolvedStatus: string): boolean {
  const s = status.trim().toLowerCase();
  return s === resolvedStatus.trim().toLowerCase() || s === "resolved" || s === "invoiced";
}
