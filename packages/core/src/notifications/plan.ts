import type { ClientMonthReport } from "../reports/client-month";
import type { RaisedIncidentType } from "../rules/incidents";

/**
 * Who is told what. Pure functions: the sync job gathers the changes, these
 * decide which channel hears about which, and what each message says.
 */

/** What a channel has asked to be told about. */
export interface ChannelPreferences {
  id: string;
  enabled: boolean;
  incidentTypes: readonly RaisedIncidentType[];
  notifyOpened: boolean;
  notifyClosed: boolean;
  notifyIntegrationHealth: boolean;
  notifyMonthlyReport: boolean;
}

export interface IncidentChange {
  incidentId: string;
  type: RaisedIncidentType;
  event: "opened" | "closed";
  /**
   * Why a closed incident closed. "resolved": a backup completed or is back
   * on time. "suppressed": someone muted the asset, or the vendor paused or
   * archived it. Nobody is told about the second kind: it was a decision,
   * not news.
   */
  reason: "resolved" | "suppressed" | null;
  client: { id: string; name: string };
  asset: { id: string; name: string };
  openedAt: Date;
  closedAt: Date | null;
  /** When the asset's last completed backup finished, if it has had one. */
  lastBackupAt: Date | null;
}

/** Most incidents in one message. A larger run is split into several messages. */
export const MAX_CHANGES_PER_MESSAGE = 100;

/** The changes one channel should hear about, in a stable order: client, asset, type, event. */
export function changesForChannel(
  channel: ChannelPreferences,
  changes: readonly IncidentChange[],
): IncidentChange[] {
  if (!channel.enabled) return [];
  return changes
    .filter(
      (change) =>
        channel.incidentTypes.includes(change.type) &&
        (change.event === "opened"
          ? channel.notifyOpened
          : channel.notifyClosed && change.reason === "resolved"),
    )
    .sort(
      (a, b) =>
        a.client.name.localeCompare(b.client.name, "en", { sensitivity: "base" }) ||
        a.asset.name.localeCompare(b.asset.name, "en", { numeric: true, sensitivity: "base" }) ||
        a.type.localeCompare(b.type) ||
        a.event.localeCompare(b.event),
    );
}

/**
 * One entry per message to send: a channel and the changes it carries. A
 * channel with nothing to hear gets no message, and one with more than
 * MAX_CHANGES_PER_MESSAGE gets several.
 */
export function planIncidentMessages(
  channels: readonly ChannelPreferences[],
  changes: readonly IncidentChange[],
): { channelId: string; changes: IncidentChange[] }[] {
  return channels.flatMap((channel) => {
    const wanted = changesForChannel(channel, changes);
    const messages: { channelId: string; changes: IncidentChange[] }[] = [];
    for (let i = 0; i < wanted.length; i += MAX_CHANGES_PER_MESSAGE) {
      messages.push({
        channelId: channel.id,
        changes: wanted.slice(i, i + MAX_CHANGES_PER_MESSAGE),
      });
    }
    return messages;
  });
}

/**
 * One message per asset for a PSA channel, since each asset has its own
 * ticket. Unlike other channels, a PSA channel is also told when an incident
 * closed because the asset was muted, paused or archived: its ticket must
 * close too, and says why.
 */
export function planPsaMessages(
  channel: ChannelPreferences,
  changes: readonly IncidentChange[],
): { channelId: string; assetId: string; changes: IncidentChange[] }[] {
  if (!channel.enabled) return [];
  const wanted = changes
    .filter((change) => channel.incidentTypes.includes(change.type))
    .sort(
      (a, b) =>
        a.openedAt.getTime() - b.openedAt.getTime() ||
        a.event.localeCompare(b.event) ||
        a.type.localeCompare(b.type),
    );
  const byAsset = new Map<string, IncidentChange[]>();
  for (const change of wanted) {
    const list = byAsset.get(change.asset.id) ?? [];
    list.push(change);
    byAsset.set(change.asset.id, list);
  }
  return [...byAsset].map(([assetId, list]) => ({ channelId: channel.id, assetId, changes: list }));
}

/** The channels to tell when an integration becomes unhealthy or recovers. */
export function channelsForIntegrationHealth(
  channels: readonly ChannelPreferences[],
): ChannelPreferences[] {
  return channels.filter((channel) => channel.enabled && channel.notifyIntegrationHealth);
}

/** The channels to send the monthly summary to. */
export function channelsForMonthlyReport(
  channels: readonly ChannelPreferences[],
): ChannelPreferences[] {
  return channels.filter((channel) => channel.enabled && channel.notifyMonthlyReport);
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------
//
// What a message says is captured when it is written, in the same
// transaction as the change, and sent as it is. It names clients, assets and
// times; it never holds credentials or a vendor's raw payload.
//
// The shape follows the Standard Webhooks convention: a type, a timestamp and
// the data. `version` changes only if the data changes in a way a receiver
// would notice.

export const NOTIFICATION_PAYLOAD_VERSION = 1;

export interface IncidentPayloadEntry {
  incidentId: string;
  type: RaisedIncidentType;
  client: { id: string; name: string };
  asset: { id: string; name: string };
  openedAt: string;
  closedAt: string | null;
  lastBackupAt: string | null;
  /** Why a closed incident closed: see IncidentChange. Null for one that opened. */
  reason: "resolved" | "suppressed" | null;
}

export interface IncidentsPayload {
  type: "incidents.changed";
  version: typeof NOTIFICATION_PAYLOAD_VERSION;
  timestamp: string;
  data: {
    workspace: { name: string };
    opened: IncidentPayloadEntry[];
    closed: IncidentPayloadEntry[];
  };
}

export interface IntegrationHealthPayload {
  type: "integration.unhealthy" | "integration.recovered";
  version: typeof NOTIFICATION_PAYLOAD_VERSION;
  timestamp: string;
  data: {
    workspace: { name: string };
    integration: { id: string; name: string; vendor: string };
    /** When the failures began. */
    failingSince: string | null;
    /** The message recorded by the last failed sync, written by us. Null on recovery. */
    error: string | null;
    /** True when retrying cannot fix it: the credentials need replacing. */
    needsAction: boolean;
  };
}

export interface TestPayload {
  type: "test";
  version: typeof NOTIFICATION_PAYLOAD_VERSION;
  timestamp: string;
  data: { workspace: { name: string }; message: string };
}

/** One client's month, as the monthly summary carries it. Shares are 0 to 1. */
export interface MonthlyReportClient {
  id: string;
  name: string;
  /** Assets counted: not paused, archived or muted indefinitely. */
  assets: number;
  onSchedule: number;
  withinSla: number;
  backups: { completed: number; failed: number };
  incidentsOpened: number;
}

export interface MonthlyReportPayload {
  type: "report.monthly";
  version: typeof NOTIFICATION_PAYLOAD_VERSION;
  timestamp: string;
  data: {
    workspace: { name: string };
    /** YYYY-MM, in the workspace's time zone. */
    month: string;
    /** Clients with at least one counted asset, least reliable first. */
    clients: MonthlyReportClient[];
    /** Clients left off the list above because it reached its limit. */
    omittedClients: number;
    totals: {
      clients: number;
      assets: number;
      /** Averages over every counted asset; null with none. */
      onSchedule: number | null;
      withinSla: number | null;
      backups: { completed: number; failed: number };
      incidentsOpened: number;
    };
  };
}

export type NotificationPayload =
  IncidentsPayload | IntegrationHealthPayload | TestPayload | MonthlyReportPayload;

const iso = (date: Date | null) => (date ? date.toISOString() : null);

export function buildIncidentsPayload(input: {
  workspaceName: string;
  at: Date;
  changes: readonly IncidentChange[];
}): IncidentsPayload {
  const entry = (change: IncidentChange): IncidentPayloadEntry => ({
    incidentId: change.incidentId,
    type: change.type,
    client: { id: change.client.id, name: change.client.name },
    asset: { id: change.asset.id, name: change.asset.name },
    openedAt: change.openedAt.toISOString(),
    closedAt: iso(change.closedAt),
    lastBackupAt: iso(change.lastBackupAt),
    reason: change.event === "closed" ? (change.reason ?? "resolved") : null,
  });
  return {
    type: "incidents.changed",
    version: NOTIFICATION_PAYLOAD_VERSION,
    timestamp: input.at.toISOString(),
    data: {
      workspace: { name: input.workspaceName },
      opened: input.changes.filter((c) => c.event === "opened").map(entry),
      closed: input.changes.filter((c) => c.event === "closed").map(entry),
    },
  };
}

export function buildIntegrationHealthPayload(input: {
  workspaceName: string;
  at: Date;
  state: "unhealthy" | "recovered";
  integration: { id: string; name: string; vendor: string };
  failingSince: Date | null;
  error: string | null;
  needsAction: boolean;
}): IntegrationHealthPayload {
  return {
    type: input.state === "unhealthy" ? "integration.unhealthy" : "integration.recovered",
    version: NOTIFICATION_PAYLOAD_VERSION,
    timestamp: input.at.toISOString(),
    data: {
      workspace: { name: input.workspaceName },
      integration: { ...input.integration },
      failingSince: iso(input.failingSince),
      error: input.state === "unhealthy" ? input.error : null,
      needsAction: input.state === "unhealthy" && input.needsAction,
    },
  };
}

export function buildTestPayload(input: { workspaceName: string; at: Date }): TestPayload {
  return {
    type: "test",
    version: NOTIFICATION_PAYLOAD_VERSION,
    timestamp: input.at.toISOString(),
    data: {
      workspace: { name: input.workspaceName },
      message: "This is a test notification. If you can read it, this channel works.",
    },
  };
}

/** Most clients listed in one monthly summary; the totals still cover them all. */
export const MAX_REPORT_CLIENTS = 500;

export function buildMonthlyReportPayload(input: {
  workspaceName: string;
  at: Date;
  month: string;
  reports: readonly { client: { id: string; name: string }; report: ClientMonthReport }[];
}): MonthlyReportPayload {
  const clients = input.reports
    .filter(({ report }) => report.summary.assets > 0)
    .map(({ client, report }) => ({
      id: client.id,
      name: client.name,
      assets: report.summary.assets,
      onSchedule: report.summary.onSchedule!,
      withinSla: report.summary.withinSla!,
      backups: { ...report.summary.backups },
      incidentsOpened: Object.values(report.incidents.opened).reduce((a, b) => a + b, 0),
    }))
    .sort(
      (a, b) =>
        a.onSchedule - b.onSchedule ||
        a.withinSla - b.withinSla ||
        b.backups.failed - a.backups.failed ||
        a.name.localeCompare(b.name, "en", { sensitivity: "base" }),
    );
  const assets = clients.reduce((sum, client) => sum + client.assets, 0);
  const weighted = (pick: (client: MonthlyReportClient) => number) =>
    assets === 0
      ? null
      : clients.reduce((sum, client) => sum + pick(client) * client.assets, 0) / assets;
  return {
    type: "report.monthly",
    version: NOTIFICATION_PAYLOAD_VERSION,
    timestamp: input.at.toISOString(),
    data: {
      workspace: { name: input.workspaceName },
      month: input.month,
      clients: clients.slice(0, MAX_REPORT_CLIENTS),
      omittedClients: Math.max(0, clients.length - MAX_REPORT_CLIENTS),
      totals: {
        clients: clients.length,
        assets,
        onSchedule: weighted((client) => client.onSchedule),
        withinSla: weighted((client) => client.withinSla),
        backups: {
          completed: clients.reduce((sum, client) => sum + client.backups.completed, 0),
          failed: clients.reduce((sum, client) => sum + client.backups.failed, 0),
        },
        incidentsOpened: clients.reduce((sum, client) => sum + client.incidentsOpened, 0),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Retries
// ---------------------------------------------------------------------------

/**
 * How long to wait before each retry, by the number of attempts already made.
 * Eight attempts over roughly nine hours: long enough to ride out a
 * receiver's deploy or a night-time outage, short enough that news about a
 * backup is still news when it arrives.
 */
export const RETRY_DELAYS_MINUTES = [1, 5, 15, 30, 60, 120, 240] as const;
export const MAX_DELIVERY_ATTEMPTS = RETRY_DELAYS_MINUTES.length + 1;

/** When to try again after `attempts` failed attempts, or null to give up. */
export function nextAttemptAt(attempts: number, now: Date): Date | null {
  if (attempts >= MAX_DELIVERY_ATTEMPTS) return null;
  const minutes = RETRY_DELAYS_MINUTES[Math.max(0, attempts - 1)]!;
  return new Date(now.getTime() + minutes * 60_000);
}
