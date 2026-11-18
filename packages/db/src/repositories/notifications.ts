import { randomUUID } from "node:crypto";
import {
  buildIncidentsPayload,
  buildIntegrationHealthPayload,
  channelsForIntegrationHealth,
  nextAttemptAt,
  planIncidentMessages,
  RAISED_INCIDENT_TYPES,
  type ChannelPreferences,
  type IncidentChange,
  type NotificationPayload,
  type RaisedIncidentType,
} from "@valtrexia/core";
import {
  decryptJson,
  encryptJson,
  type EncryptedEnvelope,
  type KeyProvider,
  type Secret,
} from "@valtrexia/core/server";
import type { TenantContext } from "../db";
import { Prisma } from "../generated/prisma/client";
import { recordAudit } from "./audit";

/**
 * Notification channels and the outbox.
 *
 * A channel's destination is stored encrypted, like vendor credentials: a
 * webhook URL often carries a token in its path, and the signing secret is a
 * secret. Neither is ever selected for the browser after it is saved.
 *
 * The outbox is written inside the caller's transaction, so a message exists
 * exactly when the change it reports does. The worker sends it later.
 */

function channelContext(tenantId: string, channelId: string) {
  return { tenantId, recordId: channelId, purpose: "notification-channel" } as const;
}

/** What is encrypted for a webhook channel. */
export interface WebhookDestination {
  url: string;
  signingSecret: string;
}

/** Columns that are safe to show. No destination, no secret. */
export const channelSummarySelect = {
  id: true,
  type: true,
  name: true,
  enabled: true,
  incidentTypes: true,
  notifyOpened: true,
  notifyClosed: true,
  notifyIntegrationHealth: true,
  config: true,
  createdAt: true,
} satisfies Prisma.NotificationChannelSelect;

export type ChannelSummary = Prisma.NotificationChannelGetPayload<{
  select: typeof channelSummarySelect;
}>;

export interface ChannelPreferencesInput {
  incidentTypes: readonly RaisedIncidentType[];
  notifyOpened: boolean;
  notifyClosed: boolean;
  notifyIntegrationHealth: boolean;
}

export class ChannelNameTakenError extends Error {
  constructor() {
    super("A channel with this name already exists.");
    this.name = "ChannelNameTakenError";
  }
}

/**
 * Creates a webhook channel with its destination encrypted, and audits it.
 * The audit entry names the channel and the host it sends to, never the
 * path, which may carry a token.
 */
export async function createWebhookChannel(
  context: TenantContext,
  keyProvider: KeyProvider,
  input: {
    name: string;
    destination: Secret<WebhookDestination>;
    preferences: ChannelPreferencesInput;
    actorUserId: string | null;
    ip?: string | null;
  },
): Promise<ChannelSummary> {
  const { tx, tenantId } = context;
  if (
    await tx.notificationChannel.findFirst({ where: { name: input.name }, select: { id: true } })
  ) {
    throw new ChannelNameTakenError();
  }
  const id = randomUUID();
  const destination = input.destination.expose();
  const host = new URL(destination.url).host;
  const envelope = await encryptJson(destination, channelContext(tenantId, id), keyProvider);

  const channel = await tx.notificationChannel.create({
    data: {
      id,
      tenantId,
      type: "webhook",
      name: input.name,
      ...input.preferences,
      incidentTypes: [...input.preferences.incidentTypes],
      config: { host },
      secretEnc: envelope satisfies EncryptedEnvelope,
    },
    select: channelSummarySelect,
  });
  await recordAudit(context, {
    action: "notification_channel.created",
    actorUserId: input.actorUserId,
    targetType: "notification_channel",
    targetId: id,
    metadata: { type: "webhook", name: input.name, host },
    ip: input.ip ?? null,
  });
  return channel;
}

/**
 * Creates an email channel. Its recipients are kept in `config`, visible to
 * the workspace: they are colleagues' addresses, not secrets. The audit entry
 * records how many there are.
 */
export async function createEmailChannel(
  context: TenantContext,
  input: {
    name: string;
    recipients: readonly string[];
    preferences: ChannelPreferencesInput;
    actorUserId: string | null;
    ip?: string | null;
  },
): Promise<ChannelSummary> {
  const { tx, tenantId } = context;
  if (
    await tx.notificationChannel.findFirst({ where: { name: input.name }, select: { id: true } })
  ) {
    throw new ChannelNameTakenError();
  }
  const channel = await tx.notificationChannel.create({
    data: {
      tenantId,
      type: "email",
      name: input.name,
      ...input.preferences,
      incidentTypes: [...input.preferences.incidentTypes],
      config: { recipients: [...input.recipients] },
      secretEnc: Prisma.DbNull,
    },
    select: channelSummarySelect,
  });
  await recordAudit(context, {
    action: "notification_channel.created",
    actorUserId: input.actorUserId,
    targetType: "notification_channel",
    targetId: channel.id,
    metadata: { type: "email", name: input.name, recipients: input.recipients.length },
    ip: input.ip ?? null,
  });
  return channel;
}

/**
 * Turns a channel on or off, and audits it. A channel turned off is told
 * nothing new, and what was already queued for it is not sent. Returns false
 * if the tenant has no such channel; true if it changed or was already so.
 */
export async function setNotificationChannelEnabled(
  context: TenantContext,
  input: { id: string; enabled: boolean; actorUserId: string | null; ip?: string | null },
): Promise<boolean> {
  const existing = await context.tx.notificationChannel.findUnique({
    where: { id: input.id },
    select: { id: true, name: true, type: true, enabled: true },
  });
  if (!existing) return false;
  if (existing.enabled === input.enabled) return true;
  await context.tx.notificationChannel.update({
    where: { id: existing.id },
    data: { enabled: input.enabled },
  });
  await recordAudit(context, {
    action: input.enabled ? "notification_channel.enabled" : "notification_channel.disabled",
    actorUserId: input.actorUserId,
    targetType: "notification_channel",
    targetId: existing.id,
    metadata: { type: existing.type, name: existing.name },
    ip: input.ip ?? null,
  });
  return true;
}

export interface RecentBatch {
  id: string;
  channelId: string;
  kind: "incidents" | "integration" | "test";
  status: "pending" | "sent" | "failed";
  attempts: number;
  /** A message we wrote about the last failed attempt. */
  lastError: string | null;
  createdAt: Date;
  sentAt: Date | null;
  nextAttemptAt: Date;
}

/** The most recent messages for each of the tenant's channels, newest first. */
export async function listRecentBatches(
  { tx }: TenantContext,
  input: { perChannel: number },
): Promise<Map<string, RecentBatch[]>> {
  const channels = await tx.notificationChannel.findMany({ select: { id: true } });
  const byChannel = new Map<string, RecentBatch[]>();
  for (const channel of channels) {
    byChannel.set(
      channel.id,
      await tx.notificationBatch.findMany({
        where: { channelId: channel.id },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        take: input.perChannel,
        select: {
          id: true,
          channelId: true,
          kind: true,
          status: true,
          attempts: true,
          lastError: true,
          createdAt: true,
          sentAt: true,
          nextAttemptAt: true,
        },
      }),
    );
  }
  return byChannel;
}

/** Every channel in the tenant, oldest first, without destinations or secrets. */
export async function listNotificationChannels({ tx }: TenantContext): Promise<ChannelSummary[]> {
  return tx.notificationChannel.findMany({
    orderBy: { createdAt: "asc" },
    select: channelSummarySelect,
  });
}

/**
 * Deletes a channel, with its outbox and delivery record, and audits it.
 * Returns false if the tenant has no such channel.
 */
export async function deleteNotificationChannel(
  context: TenantContext,
  input: { id: string; actorUserId: string | null; ip?: string | null },
): Promise<boolean> {
  const existing = await context.tx.notificationChannel.findUnique({
    where: { id: input.id },
    select: { id: true, name: true, type: true },
  });
  if (!existing) return false;
  await context.tx.notificationChannel.delete({ where: { id: existing.id } });
  await recordAudit(context, {
    action: "notification_channel.deleted",
    actorUserId: input.actorUserId,
    targetType: "notification_channel",
    targetId: existing.id,
    metadata: { type: existing.type, name: existing.name },
    ip: input.ip ?? null,
  });
  return true;
}

/** Decrypts a channel's destination. Server-side only: the worker, when sending. */
export async function decryptChannelDestination(
  { tenantId }: Pick<TenantContext, "tenantId">,
  keyProvider: KeyProvider,
  channel: { id: string; secretEnc: unknown },
): Promise<Secret<WebhookDestination>> {
  return (await decryptJson(
    channel.secretEnc,
    channelContext(tenantId, channel.id),
    keyProvider,
  )) as Secret<WebhookDestination>;
}

async function channelPreferences({ tx }: TenantContext): Promise<ChannelPreferences[]> {
  const rows = await tx.notificationChannel.findMany({
    where: { enabled: true },
    select: {
      id: true,
      enabled: true,
      incidentTypes: true,
      notifyOpened: true,
      notifyClosed: true,
      notifyIntegrationHealth: true,
    },
  });
  return rows.map((row) => ({
    ...row,
    incidentTypes: row.incidentTypes.filter((type): type is RaisedIncidentType =>
      (RAISED_INCIDENT_TYPES as readonly string[]).includes(type),
    ),
  }));
}

async function workspaceName({ tx, tenantId }: TenantContext): Promise<string> {
  const tenant = await tx.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { name: true },
  });
  return tenant.name;
}

/**
 * Queues messages about incidents that opened or closed, inside the caller's
 * transaction.
 *
 * Each channel is told about each event of each incident at most once. That
 * is checked here, and enforced again by a unique key on the delivery record,
 * so a sync that runs twice, or a retry after a crash, cannot tell anyone the
 * same thing twice.
 *
 * Returns how many messages were queued.
 */
export async function queueIncidentNotifications(
  context: TenantContext,
  input: { changes: readonly IncidentChange[]; now: Date },
): Promise<number> {
  if (input.changes.length === 0) return 0;
  const channels = await channelPreferences(context);
  if (channels.length === 0) return 0;
  const { tx, tenantId } = context;

  const already = await tx.notificationDelivery.findMany({
    where: { incidentId: { in: input.changes.map((change) => change.incidentId) } },
    select: { channelId: true, incidentId: true, event: true },
  });
  const told = new Set(already.map((d) => `${d.channelId}|${d.incidentId}|${d.event}`));

  const messages = channels.flatMap((channel) =>
    planIncidentMessages(
      [channel],
      input.changes.filter((c) => !told.has(`${channel.id}|${c.incidentId}|${c.event}`)),
    ),
  );
  if (messages.length === 0) return 0;

  const name = await workspaceName(context);
  for (const message of messages) {
    const batch = await tx.notificationBatch.create({
      data: {
        tenantId,
        channelId: message.channelId,
        kind: "incidents",
        payload: buildIncidentsPayload({
          workspaceName: name,
          at: input.now,
          changes: message.changes,
        }) as unknown as Prisma.InputJsonValue,
        nextAttemptAt: input.now,
      },
      select: { id: true },
    });
    await tx.notificationDelivery.createMany({
      data: message.changes.map((change) => ({
        tenantId,
        channelId: message.channelId,
        incidentId: change.incidentId,
        event: change.event,
        batchId: batch.id,
      })),
    });
  }
  return messages.length;
}

/**
 * Queues one message per interested channel saying an integration has become
 * unhealthy or has recovered. The caller decides that a transition happened;
 * `integrations.unhealthy_since` records it, so it is said once each way.
 */
export async function queueIntegrationHealthNotifications(
  context: TenantContext,
  input: {
    now: Date;
    state: "unhealthy" | "recovered";
    integration: { id: string; name: string; vendor: string };
    failingSince: Date | null;
    error: string | null;
    needsAction: boolean;
  },
): Promise<number> {
  const channels = channelsForIntegrationHealth(await channelPreferences(context));
  if (channels.length === 0) return 0;
  const payload = buildIntegrationHealthPayload({
    workspaceName: await workspaceName(context),
    at: input.now,
    state: input.state,
    integration: input.integration,
    failingSince: input.failingSince,
    error: input.error,
    needsAction: input.needsAction,
  }) as unknown as Prisma.InputJsonValue;
  await context.tx.notificationBatch.createMany({
    data: channels.map((channel) => ({
      tenantId: context.tenantId,
      channelId: channel.id,
      kind: "integration" as const,
      payload,
      nextAttemptAt: input.now,
    })),
  });
  return channels.length;
}

/** Queues a test message for one channel. Returns false if the tenant has no such channel. */
export async function queueTestNotification(
  context: TenantContext,
  input: { channelId: string; payload: NotificationPayload; now: Date },
): Promise<string | null> {
  const channel = await context.tx.notificationChannel.findUnique({
    where: { id: input.channelId },
    select: { id: true },
  });
  if (!channel) return null;
  const batch = await context.tx.notificationBatch.create({
    data: {
      tenantId: context.tenantId,
      channelId: channel.id,
      kind: "test",
      payload: input.payload as unknown as Prisma.InputJsonValue,
      nextAttemptAt: input.now,
    },
    select: { id: true },
  });
  return batch.id;
}

export interface ClaimedBatch {
  id: string;
  kind: "incidents" | "integration" | "test";
  payload: unknown;
  attempts: number;
  channel: {
    id: string;
    name: string;
    type: "webhook" | "email";
    enabled: boolean;
    secretEnc: unknown;
    /** What may be shown: for email, the recipients. */
    config: unknown;
  };
  /** The workspace's time zone, for dates in an email. */
  timeZone: string;
}

/**
 * Takes a due batch for sending. The batch's next attempt is pushed past the
 * lease before anything is sent, in its own short transaction, so a second
 * worker looking at the same moment finds nothing to take. If this worker
 * dies mid-send, the batch becomes due again when the lease runs out.
 *
 * Returns null when the batch is gone, already sent, given up on, or not due:
 * another worker took it first.
 */
export async function claimNotificationBatch(
  { tx }: TenantContext,
  input: { batchId: string; now: Date; leaseMs: number },
): Promise<ClaimedBatch | null> {
  const taken = await tx.notificationBatch.updateMany({
    where: { id: input.batchId, status: "pending", nextAttemptAt: { lte: input.now } },
    data: {
      attempts: { increment: 1 },
      nextAttemptAt: new Date(input.now.getTime() + input.leaseMs),
    },
  });
  if (taken.count === 0) return null;
  const batch = await tx.notificationBatch.findUniqueOrThrow({
    where: { id: input.batchId },
    select: {
      id: true,
      kind: true,
      payload: true,
      attempts: true,
      channel: {
        select: { id: true, name: true, type: true, enabled: true, secretEnc: true, config: true },
      },
      tenant: { select: { timeZone: true } },
    },
  });
  const { tenant, ...rest } = batch;
  return { ...rest, timeZone: tenant.timeZone };
}

export type BatchOutcome =
  | { status: "sent" }
  /** It may work later. Retried on the schedule until the attempts run out. */
  | { status: "retry"; error: string }
  /** It will not work however often it is tried. */
  | { status: "failed"; error: string };

/** Records how an attempt went, and when to try again if it should be. */
export async function finishNotificationBatch(
  { tx }: TenantContext,
  input: { batchId: string; attempts: number; now: Date; outcome: BatchOutcome },
): Promise<"sent" | "retrying" | "failed"> {
  const { outcome } = input;
  if (outcome.status === "sent") {
    await tx.notificationBatch.update({
      where: { id: input.batchId },
      data: { status: "sent", sentAt: input.now, lastError: null },
    });
    return "sent";
  }
  const retryAt = outcome.status === "retry" ? nextAttemptAt(input.attempts, input.now) : null;
  await tx.notificationBatch.update({
    where: { id: input.batchId },
    data:
      retryAt === null
        ? { status: "failed", lastError: outcome.error.slice(0, 500) }
        : { nextAttemptAt: retryAt, lastError: outcome.error.slice(0, 500) },
  });
  return retryAt === null ? "failed" : "retrying";
}
