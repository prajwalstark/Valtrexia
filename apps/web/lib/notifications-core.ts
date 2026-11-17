import { buildTestPayload, RAISED_INCIDENT_TYPES, type RaisedIncidentType } from "@valtrexia/core";
import {
  generateWebhookSecret,
  MAX_EMAIL_RECIPIENTS,
  OutboundRefusedError,
  parseOutboundUrl,
  resolvePublicAddresses,
  Secret,
  type KeyProvider,
  type OutboundPolicy,
  type Resolver,
} from "@valtrexia/core/server";
import {
  ChannelNameTakenError,
  createEmailChannel,
  createWebhookChannel,
  deleteNotificationChannel,
  listNotificationChannels,
  listRecentBatches,
  queueTestNotification,
  setNotificationChannelEnabled,
  type ChannelSummary,
  type Db,
  type RecentBatch,
} from "@valtrexia/db";
import { z } from "zod";
import type { TenantSession } from "./session-core";

/**
 * Managing where notifications go. No framework code, so it is tested
 * directly against Postgres. The page that uses it arrives with the email
 * channel; the rules are here now so the worker and the page share them.
 *
 * Owners manage channels. Anyone in the workspace may see which exist, but
 * never a destination: a webhook URL often carries a token in its path.
 */

export interface NotificationDeps {
  db: Db;
  keyProvider: KeyProvider;
  /** What destinations may be. Strict unless set for local development. */
  outboundPolicy: OutboundPolicy;
  ip?: string | null;
  /** Replaces DNS. For tests. */
  resolver?: Resolver;
  now?: Date;
}

export type ChannelField = "name" | "url" | "recipients" | "incidentTypes";

export type ChannelState =
  | { status: "idle" }
  /** `signingSecret` is present once, when a webhook channel is created, and never again. */
  | { status: "ok"; message: string; channelId?: string; signingSecret?: string }
  | { status: "error"; message: string; fieldErrors?: Partial<Record<ChannelField, string>> };

const OWNERS_ONLY = "Only workspace owners can manage notification channels.";
const NOT_FOUND = "That channel no longer exists.";

const nameSchema = z.string().trim().min(1).max(80);
const typesSchema = z
  .array(z.enum(RAISED_INCIDENT_TYPES))
  .min(1)
  .transform((types) => [...new Set(types)]);

/**
 * Creates a webhook channel. The URL is checked before anything is saved:
 * https only, no credentials in it, and a host that resolves to public
 * addresses only. The worker checks again at every send, because DNS can
 * change after this.
 *
 * Returns the signing secret, once. It is stored encrypted and cannot be
 * shown again; a lost secret means creating the channel again.
 */
export async function createWebhookChannelFor(
  deps: NotificationDeps,
  session: TenantSession,
  input: ChannelInput & { url: unknown },
): Promise<ChannelState> {
  if (session.role !== "owner") return { status: "error", message: OWNERS_ONLY };

  const fieldErrors: Partial<Record<ChannelField, string>> = {};
  const { name, types, preferences } = commonFields(input, fieldErrors);
  let url: string | null = null;
  if (typeof input.url !== "string" || input.url.trim() === "") {
    fieldErrors.url = "Enter the URL to send to.";
  } else if (input.url.length > 2048) {
    fieldErrors.url = "That URL is too long.";
  } else {
    try {
      const parsed = parseOutboundUrl(input.url.trim(), deps.outboundPolicy);
      await resolvePublicAddresses(
        parsed.hostname.replace(/^\[|\]$/g, ""),
        deps.outboundPolicy,
        deps.resolver,
      );
      url = parsed.toString();
    } catch (error) {
      if (!(error instanceof OutboundRefusedError)) throw error;
      fieldErrors.url = error.message;
    }
  }
  if (!name.success || !types.success || url === null) {
    return { status: "error", message: "Check the highlighted fields.", fieldErrors };
  }

  const signingSecret = generateWebhookSecret();
  try {
    const channel = await deps.db.withTenant(session.tenantId, (context) =>
      createWebhookChannel(context, deps.keyProvider, {
        name: name.data,
        destination: new Secret({ url, signingSecret }),
        preferences: { ...preferences, incidentTypes: types.data },
        actorUserId: session.userId,
        ip: deps.ip ?? null,
      }),
    );
    return {
      status: "ok",
      message: "Channel created. Copy the signing secret now: it will not be shown again.",
      channelId: channel.id,
      signingSecret,
    };
  } catch (error) {
    if (error instanceof ChannelNameTakenError) return NAME_TAKEN;
    throw error;
  }
}

const NAME_TAKEN: ChannelState = {
  status: "error",
  message: "Check the highlighted fields.",
  fieldErrors: { name: "A channel with this name already exists." },
};

interface ChannelInput {
  name: unknown;
  incidentTypes: unknown;
  notifyOpened: unknown;
  notifyClosed: unknown;
  notifyIntegrationHealth: unknown;
}

/** The fields every kind of channel has, checked the same way for each. */
function commonFields(input: ChannelInput, fieldErrors: Partial<Record<ChannelField, string>>) {
  const name = nameSchema.safeParse(input.name);
  if (!name.success) fieldErrors.name = "Give the channel a name of up to 80 characters.";
  const parsed = typesSchema.safeParse(input.incidentTypes);
  if (!parsed.success) fieldErrors.incidentTypes = "Choose at least one kind of incident.";
  const on = (value: unknown) => value === true || value === "on";
  return {
    name,
    types: parsed.success
      ? { success: true as const, data: parsed.data as RaisedIncidentType[] }
      : { success: false as const },
    preferences: {
      notifyOpened: on(input.notifyOpened),
      notifyClosed: on(input.notifyClosed),
      notifyIntegrationHealth: on(input.notifyIntegrationHealth),
    },
  };
}

const emailSchema = z.email();

/**
 * Reads a list of email addresses as people type them: separated by commas,
 * semicolons, spaces or new lines. Repeats are dropped, ignoring case.
 */
export function parseRecipients(
  value: unknown,
): { ok: true; recipients: string[] } | { ok: false; message: string } {
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, message: "Enter at least one email address." };
  }
  const seen = new Set<string>();
  const recipients: string[] = [];
  for (const part of value.split(/[\s,;]+/)) {
    const address = part.trim();
    if (address === "") continue;
    if (!emailSchema.safeParse(address).success || address.length > 254) {
      return { ok: false, message: `${address.slice(0, 60)} is not an email address.` };
    }
    if (seen.has(address.toLowerCase())) continue;
    seen.add(address.toLowerCase());
    recipients.push(address);
  }
  if (recipients.length === 0) return { ok: false, message: "Enter at least one email address." };
  if (recipients.length > MAX_EMAIL_RECIPIENTS) {
    return { ok: false, message: `Up to ${MAX_EMAIL_RECIPIENTS} addresses per channel.` };
  }
  return { ok: true, recipients };
}

/**
 * Creates an email channel. Owners only, and only when this server has email
 * set up: a channel that could never send would only look like it worked.
 */
export async function createEmailChannelFor(
  deps: Pick<NotificationDeps, "db" | "ip"> & { emailAvailable: boolean },
  session: TenantSession,
  input: ChannelInput & { recipients: unknown },
): Promise<ChannelState> {
  if (session.role !== "owner") return { status: "error", message: OWNERS_ONLY };
  if (!deps.emailAvailable) {
    return { status: "error", message: "Email is not set up on this server yet." };
  }
  const fieldErrors: Partial<Record<ChannelField, string>> = {};
  const { name, types, preferences } = commonFields(input, fieldErrors);
  const recipients = parseRecipients(input.recipients);
  if (!recipients.ok) fieldErrors.recipients = recipients.message;
  if (!name.success || !types.success || !recipients.ok) {
    return { status: "error", message: "Check the highlighted fields.", fieldErrors };
  }
  try {
    const channel = await deps.db.withTenant(session.tenantId, (context) =>
      createEmailChannel(context, {
        name: name.data,
        recipients: recipients.recipients,
        preferences: { ...preferences, incidentTypes: types.data },
        actorUserId: session.userId,
        ip: deps.ip ?? null,
      }),
    );
    return { status: "ok", message: "Channel created.", channelId: channel.id };
  } catch (error) {
    if (error instanceof ChannelNameTakenError) return NAME_TAKEN;
    throw error;
  }
}

/** Turns a channel on or off. Owners only. */
export async function setChannelEnabledFor(
  deps: Pick<NotificationDeps, "db" | "ip">,
  session: TenantSession,
  channelId: string,
  enabled: boolean,
): Promise<ChannelState> {
  if (session.role !== "owner") return { status: "error", message: OWNERS_ONLY };
  if (!z.uuid().safeParse(channelId).success) return { status: "error", message: NOT_FOUND };
  const found = await deps.db.withTenant(session.tenantId, (context) =>
    setNotificationChannelEnabled(context, {
      id: channelId,
      enabled,
      actorUserId: session.userId,
      ip: deps.ip ?? null,
    }),
  );
  if (!found) return { status: "error", message: NOT_FOUND };
  return { status: "ok", message: enabled ? "Channel turned on." : "Channel turned off." };
}

/** Messages listed per channel on the page. */
export const RECENT_PER_CHANNEL = 5;

export interface NotificationsPage {
  timeZone: string;
  channels: (ChannelSummary & { recent: RecentBatch[] })[];
}

/** Everything the notifications page shows. Anyone may look; nothing secret is in it. */
export async function getNotificationsPage(
  deps: Pick<NotificationDeps, "db">,
  session: TenantSession,
): Promise<NotificationsPage> {
  return deps.db.withTenant(session.tenantId, async (context) => {
    const tenant = await context.tx.tenant.findUniqueOrThrow({
      where: { id: session.tenantId },
      select: { timeZone: true },
    });
    const channels = await listNotificationChannels(context);
    const recent = await listRecentBatches(context, { perChannel: RECENT_PER_CHANNEL });
    return {
      timeZone: tenant.timeZone,
      channels: channels.map((channel) => ({ ...channel, recent: recent.get(channel.id) ?? [] })),
    };
  });
}

/** Every channel in the workspace, without destinations or secrets. Anyone may look. */
export async function listChannelsFor(
  deps: Pick<NotificationDeps, "db">,
  session: TenantSession,
): Promise<ChannelSummary[]> {
  return deps.db.withTenant(session.tenantId, (context) => listNotificationChannels(context));
}

/** Deletes a channel and everything queued for it. Owners only. */
export async function deleteChannelFor(
  deps: Pick<NotificationDeps, "db" | "ip">,
  session: TenantSession,
  channelId: string,
): Promise<ChannelState> {
  if (session.role !== "owner") return { status: "error", message: OWNERS_ONLY };
  if (!z.uuid().safeParse(channelId).success) return { status: "error", message: NOT_FOUND };
  const deleted = await deps.db.withTenant(session.tenantId, (context) =>
    deleteNotificationChannel(context, {
      id: channelId,
      actorUserId: session.userId,
      ip: deps.ip ?? null,
    }),
  );
  return deleted
    ? { status: "ok", message: "Channel deleted." }
    : { status: "error", message: NOT_FOUND };
}

/** Queues a test message for a channel. The worker sends it within a minute. Owners only. */
export async function sendTestNotificationFor(
  deps: Pick<NotificationDeps, "db" | "now">,
  session: TenantSession,
  channelId: string,
): Promise<ChannelState> {
  if (session.role !== "owner") return { status: "error", message: OWNERS_ONLY };
  if (!z.uuid().safeParse(channelId).success) return { status: "error", message: NOT_FOUND };
  const now = deps.now ?? new Date();
  const batchId = await deps.db.withTenant(session.tenantId, async (context) => {
    const tenant = await context.tx.tenant.findUniqueOrThrow({
      where: { id: session.tenantId },
      select: { name: true },
    });
    return queueTestNotification(context, {
      channelId,
      payload: buildTestPayload({ workspaceName: tenant.name, at: now }),
      now,
    });
  });
  return batchId
    ? { status: "ok", message: "A test message is on its way. It is sent within a minute." }
    : { status: "error", message: NOT_FOUND };
}
