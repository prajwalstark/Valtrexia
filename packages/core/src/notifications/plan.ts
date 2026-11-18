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

/** The channels to tell when an integration becomes unhealthy or recovers. */
export function channelsForIntegrationHealth(
  channels: readonly ChannelPreferences[],
): ChannelPreferences[] {
  return channels.filter((channel) => channel.enabled && channel.notifyIntegrationHealth);
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

export type NotificationPayload = IncidentsPayload | IntegrationHealthPayload | TestPayload;

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
