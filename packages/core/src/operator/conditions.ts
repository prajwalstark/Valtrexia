import { brand } from "../brand";

/**
 * What the operator is alerted about: conditions over the whole fleet, worked
 * out from counts. Pure, so every threshold is tested directly.
 */

export interface FleetSnapshot {
  /** When the numbers were taken, ISO 8601. */
  at: string;
  integrations: { total: number; failing: number; overdue: number };
  notifications: { overdue: number; failedLastHour: number };
  /** The last maintenance run, or null if none has finished since Redis was emptied. */
  maintenance: { ok: boolean; at: string } | null;
  /** Jobs per queue, by state. */
  queues: Record<string, { waiting: number; active: number; delayed: number; failed: number }>;
}

/** Thresholds, from the Phase 3 plan (section 4.2). */
export const OPERATOR_THRESHOLDS = {
  /** Integrations failing: over this share of all of them... */
  failingShare: 0.25,
  /** ...and at least this many, so two small workspaces with a bad key are not an outage. */
  failingMinimum: 4,
  /** Minutes past twice the sync interval before an integration counts as overdue. */
  overdueGraceMinutes: 30,
  /** Notification messages more than 15 minutes overdue. */
  backlog: 100,
} as const;

export type OperatorCondition =
  | "integrations_failing"
  | "integrations_overdue"
  | "notifications_failing"
  | "notifications_backlog"
  | "maintenance_failing";

export const OPERATOR_CONDITIONS: readonly OperatorCondition[] = [
  "integrations_failing",
  "integrations_overdue",
  "notifications_failing",
  "notifications_backlog",
  "maintenance_failing",
];

export interface ConditionState {
  condition: OperatorCondition;
  active: boolean;
  /** The numbers behind it. Counts only. */
  details: Record<string, number | boolean | string>;
}

/** Every condition, active or not, for one snapshot. */
export function evaluateFleet(snapshot: FleetSnapshot): ConditionState[] {
  const { integrations, notifications, maintenance } = snapshot;
  const share = integrations.total > 0 ? integrations.failing / integrations.total : 0;
  return [
    {
      condition: "integrations_failing",
      active:
        integrations.failing >= OPERATOR_THRESHOLDS.failingMinimum &&
        share > OPERATOR_THRESHOLDS.failingShare,
      details: { failing: integrations.failing, total: integrations.total },
    },
    {
      condition: "integrations_overdue",
      active: integrations.overdue > 0,
      details: { overdue: integrations.overdue, total: integrations.total },
    },
    {
      condition: "notifications_failing",
      active: notifications.failedLastHour > 0,
      details: { failedLastHour: notifications.failedLastHour },
    },
    {
      condition: "notifications_backlog",
      active: notifications.overdue > OPERATOR_THRESHOLDS.backlog,
      details: { overdue: notifications.overdue },
    },
    {
      condition: "maintenance_failing",
      active: maintenance !== null && !maintenance.ok,
      details: { lastRunOk: maintenance?.ok ?? true },
    },
  ];
}

const TITLES: Record<OperatorCondition, string> = {
  integrations_failing: "Syncs are failing across many workspaces",
  integrations_overdue: "Integrations are not being synced",
  notifications_failing: "Notifications are failing to send",
  notifications_backlog: "Notifications are piling up",
  maintenance_failing: "Maintenance is failing",
};

const WHAT_TO_CHECK: Record<OperatorCondition, string> = {
  integrations_failing:
    "Many integrations failing at once usually means a vendor outage or a network problem from the worker, not a problem in each workspace. Check the worker's log for the failure kinds.",
  integrations_overdue:
    "Integrations are going unsynced. Check that a worker is running (/api/status) and that its log shows syncs finishing.",
  notifications_failing:
    "Messages were given up on in the last hour. Check the email provider's settings and status, and the worker's log for delivery errors.",
  notifications_backlog:
    "Messages are due but not being sent. Check that a worker is running, and the email provider's rate limits.",
  maintenance_failing:
    "The last maintenance run (retention and workspace deletion) failed. Check the worker's log for the error.",
};

/** One sentence of numbers, for an alert. */
function summary(state: Pick<ConditionState, "condition" | "details">): string {
  const d = state.details;
  switch (state.condition) {
    case "integrations_failing":
      return `${String(d.failing)} of ${String(d.total)} integrations failed their last sync.`;
    case "integrations_overdue":
      return `${String(d.overdue)} of ${String(d.total)} integrations have not synced for more than twice the sync interval.`;
    case "notifications_failing":
      return `${String(d.failedLastHour)} notification messages were given up on in the last hour.`;
    case "notifications_backlog":
      return `${String(d.overdue)} notification messages are more than 15 minutes overdue.`;
    case "maintenance_failing":
      return "The last maintenance run did not finish.";
  }
}

export interface OperatorAlertMessage {
  subject: string;
  text: string;
  /** For a webhook. `text` is what chat tools such as Slack display. */
  json: {
    type: "operator_alert.opened" | "operator_alert.closed";
    condition: OperatorCondition;
    title: string;
    summary: string;
    openedAt: string;
    closedAt: string | null;
    details: Record<string, unknown>;
    text: string;
  };
}

/** The message telling the operator an alert opened or cleared. */
export function renderOperatorAlert(
  alert: {
    condition: OperatorCondition;
    details: Record<string, unknown>;
    openedAt: Date;
    closedAt: Date | null;
  },
  event: "opened" | "closed",
): OperatorAlertMessage {
  const title = TITLES[alert.condition];
  const facts = summary({
    condition: alert.condition,
    details: alert.details as ConditionState["details"],
  });
  const subject =
    event === "opened"
      ? `[${brand.name} operator] ${title}`
      : `[${brand.name} operator] Resolved: ${title}`;
  const lines =
    event === "opened"
      ? [
          `${title}.`,
          facts,
          WHAT_TO_CHECK[alert.condition],
          `Since ${alert.openedAt.toISOString()} (UTC).`,
        ]
      : [
          `Resolved: ${title}.`,
          `It began at ${alert.openedAt.toISOString()} and cleared at ${(alert.closedAt ?? alert.openedAt).toISOString()} (UTC).`,
        ];
  const text = lines.join("\n\n");
  return {
    subject,
    text: `${text}\n\nThis alert is about the ${brand.name} service itself and went only to its operators.\n`,
    json: {
      type: event === "opened" ? "operator_alert.opened" : "operator_alert.closed",
      condition: alert.condition,
      title,
      summary: facts,
      openedAt: alert.openedAt.toISOString(),
      closedAt: alert.closedAt?.toISOString() ?? null,
      details: alert.details,
      text: `${subject}\n${event === "opened" ? facts : lines[1]}`,
    },
  };
}
