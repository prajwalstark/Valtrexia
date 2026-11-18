import { escapeHtml } from "@valtrexia/core";
import {
  evaluateFleet,
  fleetSnapshotKey,
  maintenanceStatusKey,
  OPERATOR_CONDITIONS,
  OPERATOR_THRESHOLDS,
  postJson,
  renderOperatorAlert,
  signWebhook,
  type EmailSender,
  type FleetSnapshot,
  type Logger,
  type OperatorAlertConfig,
  type OperatorCondition,
  type OutboundPolicy,
  type Resolver,
} from "@valtrexia/core/server";
import { brand } from "@valtrexia/core";
import type { Db, OperatorAlertRow } from "@valtrexia/db";

/** How long an unreported opening or clearing is retried before it is let go. */
const NOTIFY_FOR_MS = 24 * 3_600_000;
/** How long the snapshot is kept: long enough to show it is stale, not forever. */
const SNAPSHOT_TTL_SECONDS = 3_600;

export interface OperatorCheckDeps {
  db: Db;
  logger: Logger;
  redis: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
  };
  prefix: string;
  syncIntervalMinutes: number;
  /** Queues to report the depth of. */
  queues: { name: string; counts(): Promise<Record<string, number>> }[];
  alerts: OperatorAlertConfig;
  emailSender: EmailSender | null;
  outboundPolicy: OutboundPolicy;
  resolver?: Resolver;
  now?: () => Date;
}

export interface OperatorCheckResult {
  snapshot: FleetSnapshot;
  opened: OperatorCondition[];
  closed: OperatorCondition[];
  /** Openings and clearings reported to the operator in this run. */
  notified: number;
  /** Ones that could not be reported; tried again on the next run. */
  unreported: number;
}

/**
 * One look at the whole fleet: take the counts, keep them where the status
 * endpoint can read them, open or close alerts, and tell the operator about
 * any change. Runs on one schedule across all worker processes.
 */
export async function runOperatorCheck(deps: OperatorCheckDeps): Promise<OperatorCheckResult> {
  const now = (deps.now ?? (() => new Date()))();
  const snapshot = await takeSnapshot(deps, now);
  await deps.redis.set(
    fleetSnapshotKey(deps.prefix),
    JSON.stringify(snapshot),
    "EX",
    SNAPSHOT_TTL_SECONDS,
  );
  // One line per check with every number, for log-based metrics (CloudWatch
  // metric filters). Counts only.
  deps.logger.info(
    {
      metric: "fleet_health",
      integrationsTotal: snapshot.integrations.total,
      integrationsFailing: snapshot.integrations.failing,
      integrationsOverdue: snapshot.integrations.overdue,
      notificationsOverdue: snapshot.notifications.overdue,
      notificationsFailedLastHour: snapshot.notifications.failedLastHour,
      maintenanceOk: snapshot.maintenance?.ok ?? null,
      queues: snapshot.queues,
    },
    "fleet health",
  );

  const opened: OperatorCondition[] = [];
  const closed: OperatorCondition[] = [];
  for (const state of evaluateFleet(snapshot)) {
    if (state.active) {
      if (await deps.db.openOperatorAlert(state.condition, state.details))
        opened.push(state.condition);
    } else if (await deps.db.closeOperatorAlert(state.condition, now)) {
      closed.push(state.condition);
    }
  }
  for (const condition of opened) deps.logger.warn({ condition }, "operator alert opened");
  for (const condition of closed) deps.logger.info({ condition }, "operator alert cleared");

  const { notified, unreported } = await reportChanges(deps, now);
  return { snapshot, opened, closed, notified, unreported };
}

async function takeSnapshot(deps: OperatorCheckDeps, now: Date): Promise<FleetSnapshot> {
  const counts = await deps.db.fleetHealthCounts({
    overdueAfterMinutes: 2 * deps.syncIntervalMinutes + OPERATOR_THRESHOLDS.overdueGraceMinutes,
  });
  let maintenance: FleetSnapshot["maintenance"] = null;
  try {
    const stored = JSON.parse(
      (await deps.redis.get(maintenanceStatusKey(deps.prefix))) ?? "null",
    ) as unknown;
    if (
      stored &&
      typeof stored === "object" &&
      typeof (stored as { ok?: unknown }).ok === "boolean"
    ) {
      const value = stored as { ok: boolean; at?: unknown };
      maintenance = {
        ok: value.ok,
        at: typeof value.at === "string" ? value.at : now.toISOString(),
      };
    }
  } catch {
    maintenance = null;
  }
  const queues: FleetSnapshot["queues"] = {};
  for (const queue of deps.queues) {
    const c = await queue.counts();
    queues[queue.name] = {
      waiting: c.waiting ?? 0,
      active: c.active ?? 0,
      delayed: c.delayed ?? 0,
      failed: c.failed ?? 0,
    };
  }
  return {
    at: now.toISOString(),
    integrations: {
      total: counts.integrationsTotal,
      failing: counts.integrationsFailing,
      overdue: counts.integrationsOverdue,
    },
    notifications: { overdue: counts.batchesOverdue, failedLastHour: counts.batchesFailedLastHour },
    maintenance,
    queues,
  };
}

/** Tells the operator about every opening and clearing not yet reported, oldest first. */
async function reportChanges(deps: OperatorCheckDeps, now: Date) {
  const pending = await deps.db.operatorAlertsToNotify(new Date(now.getTime() - NOTIFY_FOR_MS));
  if (pending.length === 0) return { notified: 0, unreported: 0 };
  if (deps.alerts.emails.length === 0 && !deps.alerts.webhookUrl) {
    deps.logger.error(
      { pending: pending.length },
      "operator alerts have nowhere to go: set OPERATOR_ALERT_EMAIL or OPERATOR_ALERT_WEBHOOK_URL",
    );
    return { notified: 0, unreported: pending.length };
  }
  let notified = 0;
  let unreported = 0;
  for (const alert of pending) {
    if (!isKnown(alert.condition)) continue;
    const events: ("opened" | "closed")[] = [];
    if (!alert.openNotifiedAt) events.push("opened");
    if (alert.closedAt && !alert.closeNotifiedAt) events.push("closed");
    for (const event of events) {
      if (await deliver(deps, alert, event, now)) {
        await deps.db.markOperatorAlertNotified(alert.id, event, now);
        notified += 1;
      } else {
        unreported += 1;
        break;
      }
    }
  }
  return { notified, unreported };
}

function isKnown(condition: string): condition is OperatorCondition {
  return (OPERATOR_CONDITIONS as readonly string[]).includes(condition);
}

/**
 * Sends one opening or clearing to every configured destination. True only
 * if all of them took it; otherwise it is tried again on the next run, and
 * the email provider's idempotency key stops a second email.
 */
async function deliver(
  deps: OperatorCheckDeps,
  alert: OperatorAlertRow,
  event: "opened" | "closed",
  now: Date,
): Promise<boolean> {
  const message = renderOperatorAlert(
    {
      condition: alert.condition as OperatorCondition,
      details: alert.details,
      openedAt: alert.openedAt,
      closedAt: alert.closedAt,
    },
    event,
  );
  const id = `operator-${alert.id}-${event}`;
  let ok = true;

  if (deps.alerts.emails.length > 0) {
    if (!deps.emailSender) {
      deps.logger.error(
        { condition: alert.condition },
        "operator alert email not sent: email is not set up",
      );
      ok = false;
    } else {
      try {
        await deps.emailSender.send({
          to: deps.alerts.emails,
          subject: message.subject,
          text: message.text,
          html: message.text
            .trim()
            .split("\n\n")
            .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
            .join("\n"),
          idempotencyKey: id,
        });
      } catch (error) {
        deps.logger.error(
          {
            condition: alert.condition,
            errorName: error instanceof Error ? error.name : "unknown",
          },
          "operator alert email not sent",
        );
        ok = false;
      }
    }
  }

  if (deps.alerts.webhookUrl) {
    const body = JSON.stringify(message.json);
    try {
      const { status } = await postJson(deps.alerts.webhookUrl, {
        body,
        policy: deps.outboundPolicy,
        ...(deps.resolver ? { resolver: deps.resolver } : {}),
        headers: {
          "content-type": "application/json",
          "user-agent": `${brand.name}-Operator/1`,
          ...(deps.alerts.webhookSecret
            ? signWebhook({ id, timestamp: now, body }, deps.alerts.webhookSecret)
            : {}),
        },
      });
      if (status < 200 || status >= 300) {
        deps.logger.error({ condition: alert.condition, status }, "operator alert webhook refused");
        ok = false;
      }
    } catch (error) {
      deps.logger.error(
        { condition: alert.condition, errorName: error instanceof Error ? error.name : "unknown" },
        "operator alert webhook not sent",
      );
      ok = false;
    }
  }
  return ok;
}
