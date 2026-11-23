import { randomUUID } from "node:crypto";
import type { RaisedIncidentType } from "@valtrexia/core";
import {
  decryptJson,
  encryptJson,
  type EncryptedEnvelope,
  type KeyProvider,
  type Secret,
  type SyncroCredentials,
} from "@valtrexia/core/server";
import type { TenantContext } from "../db";
import { Prisma } from "../generated/prisma/client";
import { recordAudit } from "./audit";
import {
  ChannelNameTakenError,
  channelContext,
  channelSummarySelect,
  type ChannelSummary,
} from "./notifications";

/**
 * PSA channels: their settings, which PSA customer each client is, and the
 * tickets opened for assets. Tickets themselves are written by the worker;
 * this records what it did, one step at a time, so a retry carries on where
 * the last attempt stopped.
 */

/** What may be shown about a PSA channel. The API token is never here. */
export interface PsaChannelConfig {
  provider: "syncro";
  subdomain: string;
  /** The problem type set on new tickets, or null to leave Syncro's default. */
  problemType: string | null;
  /** The status a ticket is moved to when the asset recovers. */
  resolvedStatus: string;
}

export function parsePsaConfig(config: unknown): PsaChannelConfig | null {
  const c = config as Partial<PsaChannelConfig> | null;
  if (!c || c.provider !== "syncro" || typeof c.subdomain !== "string") return null;
  return {
    provider: "syncro",
    subdomain: c.subdomain,
    problemType: typeof c.problemType === "string" && c.problemType ? c.problemType : null,
    resolvedStatus:
      typeof c.resolvedStatus === "string" && c.resolvedStatus ? c.resolvedStatus : "Resolved",
  };
}

/**
 * Creates a PSA channel with its credentials encrypted, and audits it. A PSA
 * channel hears about incidents opening and closing, of the types chosen;
 * not about integrations or the monthly summary, which are not tickets.
 */
export async function createPsaChannel(
  context: TenantContext,
  keyProvider: KeyProvider,
  input: {
    name: string;
    credentials: Secret<SyncroCredentials>;
    problemType: string | null;
    resolvedStatus: string;
    incidentTypes: readonly RaisedIncidentType[];
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
  const credentials = input.credentials.expose();
  const envelope = await encryptJson(credentials, channelContext(tenantId, id), keyProvider);
  const config: PsaChannelConfig = {
    provider: "syncro",
    subdomain: credentials.subdomain,
    problemType: input.problemType,
    resolvedStatus: input.resolvedStatus,
  };
  const channel = await tx.notificationChannel.create({
    data: {
      id,
      tenantId,
      type: "psa",
      name: input.name,
      incidentTypes: [...input.incidentTypes],
      notifyOpened: true,
      notifyClosed: true,
      notifyIntegrationHealth: false,
      notifyMonthlyReport: false,
      config: config as unknown as Prisma.InputJsonValue,
      secretEnc: envelope satisfies EncryptedEnvelope,
    },
    select: channelSummarySelect,
  });
  await recordAudit(context, {
    action: "notification_channel.created",
    actorUserId: input.actorUserId,
    targetType: "notification_channel",
    targetId: id,
    metadata: {
      type: "psa",
      name: input.name,
      provider: "syncro",
      subdomain: credentials.subdomain,
    },
    ip: input.ip ?? null,
  });
  return channel;
}

export async function decryptPsaCredentials(
  { tenantId }: Pick<TenantContext, "tenantId">,
  keyProvider: KeyProvider,
  channel: { id: string; secretEnc: unknown },
): Promise<Secret<SyncroCredentials>> {
  return (await decryptJson(
    channel.secretEnc,
    channelContext(tenantId, channel.id),
    keyProvider,
  )) as Secret<SyncroCredentials>;
}

/** A PSA channel the tenant has, with what is needed to call the PSA. Null if none. */
export async function loadPsaChannel(
  { tx }: TenantContext,
  channelId: string,
): Promise<{ id: string; name: string; config: PsaChannelConfig; secretEnc: unknown } | null> {
  const row = await tx.notificationChannel.findUnique({
    where: { id: channelId },
    select: { id: true, name: true, type: true, config: true, secretEnc: true },
  });
  const config = row?.type === "psa" ? parsePsaConfig(row.config) : null;
  return row && config ? { id: row.id, name: row.name, config, secretEnc: row.secretEnc } : null;
}

export interface PsaMappingRow {
  clientId: string;
  clientName: string;
  customer: { id: string; name: string } | null;
}

/** Every client, with the PSA customer it is mapped to on this channel, if any. */
export async function listPsaMappings(
  { tx }: TenantContext,
  channelId: string,
): Promise<PsaMappingRow[]> {
  const clients = await tx.client.findMany({
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      psaCustomerMappings: {
        where: { channelId },
        select: { externalCustomerId: true, externalCustomerName: true },
      },
    },
  });
  return clients.map((client) => {
    const mapping = client.psaCustomerMappings[0];
    return {
      clientId: client.id,
      clientName: client.name,
      customer: mapping
        ? { id: mapping.externalCustomerId, name: mapping.externalCustomerName }
        : null,
    };
  });
}

/**
 * Sets which PSA customer each listed client is (null to unmap), and audits
 * the change as counts. Clients not listed are left as they are; ids that
 * are not this tenant's clients are ignored. Returns what changed.
 */
export async function setPsaMappings(
  context: TenantContext,
  input: {
    channelId: string;
    mappings: readonly { clientId: string; customer: { id: string; name: string } | null }[];
    actorUserId: string | null;
    ip?: string | null;
  },
): Promise<{ mapped: number; unmapped: number }> {
  const { tx, tenantId } = context;
  const current = new Map(
    (await listPsaMappings(context, input.channelId)).map((row) => [row.clientId, row.customer]),
  );
  let mapped = 0;
  let unmapped = 0;
  for (const { clientId, customer } of input.mappings) {
    if (!current.has(clientId)) continue;
    const before = current.get(clientId) ?? null;
    if (customer === null) {
      if (before === null) continue;
      await tx.psaCustomerMapping.deleteMany({ where: { channelId: input.channelId, clientId } });
      unmapped += 1;
      continue;
    }
    if (before && before.id === customer.id && before.name === customer.name) continue;
    await tx.psaCustomerMapping.upsert({
      where: { channelId_clientId: { channelId: input.channelId, clientId } },
      create: {
        tenantId,
        channelId: input.channelId,
        clientId,
        externalCustomerId: customer.id,
        externalCustomerName: customer.name.slice(0, 200),
      },
      update: {
        externalCustomerId: customer.id,
        externalCustomerName: customer.name.slice(0, 200),
      },
    });
    mapped += 1;
  }
  if (mapped + unmapped > 0) {
    await recordAudit(context, {
      action: "psa_mappings.updated",
      actorUserId: input.actorUserId,
      targetType: "notification_channel",
      targetId: input.channelId,
      metadata: { mapped, unmapped },
      ip: input.ip ?? null,
    });
  }
  return { mapped, unmapped };
}

/** The PSA customer a client is, on a channel, or null. */
export async function psaCustomerFor(
  { tx }: TenantContext,
  input: { channelId: string; clientId: string },
): Promise<string | null> {
  const row = await tx.psaCustomerMapping.findUnique({
    where: { channelId_clientId: input },
    select: { externalCustomerId: true },
  });
  return row?.externalCustomerId ?? null;
}

export interface PsaTicketRow {
  id: string;
  externalCustomerId: string;
  externalTicketId: string | null;
  externalTicketNumber: string | null;
  subject: string;
  createStartedAt: Date;
  lastBatchId: string | null;
}

const ticketSelect = {
  id: true,
  externalCustomerId: true,
  externalTicketId: true,
  externalTicketNumber: true,
  subject: true,
  createStartedAt: true,
  lastBatchId: true,
} satisfies Prisma.PsaTicketSelect;

/** The asset's open ticket on a channel, if it has one. */
export async function openPsaTicket(
  { tx }: TenantContext,
  input: { channelId: string; assetId: string },
): Promise<PsaTicketRow | null> {
  return tx.psaTicket.findFirst({
    where: { channelId: input.channelId, assetId: input.assetId, closedAt: null },
    select: ticketSelect,
  });
}

/**
 * Records that a ticket is about to be created, before asking the PSA. If the
 * answer is lost, the next attempt finds this row without a ticket id and
 * looks in the PSA before creating another.
 */
export async function startPsaTicket(
  { tx, tenantId }: TenantContext,
  input: {
    /** Chosen by the caller, so the subject can carry a reference to it. */
    id: string;
    channelId: string;
    assetId: string;
    externalCustomerId: string;
    subject: string;
    /** The message creating it, whose news the ticket will carry. */
    batchId: string;
    now: Date;
  },
): Promise<PsaTicketRow> {
  return tx.psaTicket.create({
    data: {
      id: input.id,
      tenantId,
      channelId: input.channelId,
      assetId: input.assetId,
      externalCustomerId: input.externalCustomerId,
      subject: input.subject,
      createStartedAt: input.now,
      lastBatchId: input.batchId,
    },
    select: ticketSelect,
  });
}

/** Records the PSA's ticket for a row whose create was started. */
export async function recordPsaTicketCreated(
  { tx }: TenantContext,
  input: { id: string; externalTicketId: string; externalTicketNumber: string | null },
): Promise<void> {
  await tx.psaTicket.update({
    where: { id: input.id },
    data: {
      externalTicketId: input.externalTicketId,
      externalTicketNumber: input.externalTicketNumber,
    },
  });
}

/** Records that this message's news was written to the ticket. */
export async function recordPsaTicketNews(
  { tx }: TenantContext,
  input: { id: string; batchId: string },
): Promise<void> {
  await tx.psaTicket.update({ where: { id: input.id }, data: { lastBatchId: input.batchId } });
}

export async function closePsaTicket(
  { tx }: TenantContext,
  input: { id: string; reason: "resolved" | "closed_in_psa"; now: Date },
): Promise<void> {
  await tx.psaTicket.updateMany({
    where: { id: input.id, closedAt: null },
    data: { closedAt: input.now, closeReason: input.reason },
  });
}

/** Whether the asset has any incident still open, of the given types. */
export async function assetHasOpenIncidents(
  { tx }: TenantContext,
  input: { assetId: string; types: readonly RaisedIncidentType[] },
): Promise<boolean> {
  const open = await tx.incident.count({
    where: { assetId: input.assetId, closedAt: null, type: { in: [...input.types] } },
  });
  return open > 0;
}

/** Changes the problem type and resolved status of a PSA channel, and audits it. False if no such channel. */
export async function updatePsaSettings(
  context: TenantContext,
  input: {
    channelId: string;
    problemType: string | null;
    resolvedStatus: string;
    actorUserId: string | null;
    ip?: string | null;
  },
): Promise<boolean> {
  const channel = await loadPsaChannel(context, input.channelId);
  if (!channel) return false;
  const config: PsaChannelConfig = {
    ...channel.config,
    problemType: input.problemType,
    resolvedStatus: input.resolvedStatus,
  };
  await context.tx.notificationChannel.update({
    where: { id: channel.id },
    data: { config: config as unknown as Prisma.InputJsonValue },
  });
  await recordAudit(context, {
    action: "psa_settings.updated",
    actorUserId: input.actorUserId,
    targetType: "notification_channel",
    targetId: channel.id,
    metadata: {
      name: channel.name,
      problemType: input.problemType,
      resolvedStatus: input.resolvedStatus,
    },
    ip: input.ip ?? null,
  });
  return true;
}

/** Replaces a PSA channel's API token, keeping its account. False if no such channel. */
export async function replacePsaCredentials(
  context: TenantContext,
  keyProvider: KeyProvider,
  input: {
    channelId: string;
    apiToken: Secret<string>;
    actorUserId: string | null;
    ip?: string | null;
  },
): Promise<boolean> {
  const channel = await loadPsaChannel(context, input.channelId);
  if (!channel) return false;
  const credentials: SyncroCredentials = {
    subdomain: channel.config.subdomain,
    apiToken: input.apiToken.expose(),
  };
  const envelope = await encryptJson(
    credentials,
    channelContext(context.tenantId, channel.id),
    keyProvider,
  );
  await context.tx.notificationChannel.update({
    where: { id: channel.id },
    data: { secretEnc: envelope satisfies EncryptedEnvelope },
  });
  await recordAudit(context, {
    action: "psa_credentials.replaced",
    actorUserId: input.actorUserId,
    targetType: "notification_channel",
    targetId: channel.id,
    metadata: { name: channel.name, subdomain: channel.config.subdomain },
    ip: input.ip ?? null,
  });
  return true;
}

/** How many clients each PSA channel has matched to a customer. */
export async function countPsaMappings({ tx }: TenantContext): Promise<Map<string, number>> {
  const rows = await tx.psaCustomerMapping.groupBy({ by: ["channelId"], _count: { _all: true } });
  return new Map(rows.map((row) => [row.channelId, row._count._all]));
}
