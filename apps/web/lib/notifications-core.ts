import { buildTestPayload, RAISED_INCIDENT_TYPES, type RaisedIncidentType } from "@valtrexia/core";
import {
  generateWebhookSecret,
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
  createWebhookChannel,
  deleteNotificationChannel,
  listNotificationChannels,
  queueTestNotification,
  type ChannelSummary,
  type Db,
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

export type ChannelField = "name" | "url" | "incidentTypes";

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
  input: {
    name: unknown;
    url: unknown;
    incidentTypes: unknown;
    notifyOpened: unknown;
    notifyClosed: unknown;
    notifyIntegrationHealth: unknown;
  },
): Promise<ChannelState> {
  if (session.role !== "owner") return { status: "error", message: OWNERS_ONLY };

  const fieldErrors: Partial<Record<ChannelField, string>> = {};
  const name = nameSchema.safeParse(input.name);
  if (!name.success) fieldErrors.name = "Give the channel a name of up to 80 characters.";
  const types = typesSchema.safeParse(input.incidentTypes);
  if (!types.success) fieldErrors.incidentTypes = "Choose at least one kind of incident.";

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
        preferences: {
          incidentTypes: types.data as RaisedIncidentType[],
          notifyOpened: input.notifyOpened === true || input.notifyOpened === "on",
          notifyClosed: input.notifyClosed === true || input.notifyClosed === "on",
          notifyIntegrationHealth:
            input.notifyIntegrationHealth === true || input.notifyIntegrationHealth === "on",
        },
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
    if (error instanceof ChannelNameTakenError) {
      return {
        status: "error",
        message: "Check the highlighted fields.",
        fieldErrors: { name: "A channel with this name already exists." },
      };
    }
    throw error;
  }
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
