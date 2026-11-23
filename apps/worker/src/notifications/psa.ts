import { randomUUID } from "node:crypto";
import {
  RAISED_INCIDENT_TYPES,
  type IncidentsPayload,
  type RaisedIncidentType,
} from "@valtrexia/core";
import {
  isClosedStatus,
  PsaError,
  refInSubject,
  SyncroClient,
  ticketNews,
  ticketRef,
  ticketSubject,
  type Logger,
} from "@valtrexia/core/server";
import {
  assetHasOpenIncidents,
  closePsaTicket,
  decryptPsaCredentials,
  openPsaTicket,
  parsePsaConfig,
  Prisma,
  psaCustomerFor,
  recordPsaTicketCreated,
  recordPsaTicketNews,
  startPsaTicket,
  type BatchOutcome,
  type ClaimedBatch,
  type Db,
  type PsaTicketRow,
  type TenantContext,
} from "@valtrexia/db";
import type { KeyProvider } from "@valtrexia/core/server";

/**
 * Sends one message to a PSA channel: an asset's incidents, as one ticket.
 *
 *   - Something opened and the asset has no open ticket: create one, with
 *     the news as its first comment.
 *   - It has one: add the news as a comment. If someone closed or deleted
 *     the ticket in the PSA, a new problem opens a new ticket instead.
 *   - Nothing is open on the asset any more: say so and move the ticket to
 *     the channel's resolved status.
 *
 * Each call to the PSA is recorded as soon as it succeeds, so a retry does
 * only what is left. The one call that cannot be made safe that way is
 * creating a ticket, since the PSA takes no idempotency key: the row is
 * written first, the subject carries a reference to it, and a retry that
 * finds the row without a ticket id looks for the ticket before making
 * another.
 */

export interface PsaDeliveryDeps {
  db: Db;
  keyProvider: KeyProvider;
  logger: Logger;
  appBaseUrl?: string | undefined;
  /** For tests: a stand-in PSA. */
  psa?: { fetch?: typeof fetch; baseUrl?: string };
}

export async function sendToPsa(
  deps: PsaDeliveryDeps,
  tenantId: string,
  batch: ClaimedBatch,
  now: Date,
): Promise<BatchOutcome> {
  const config = parsePsaConfig(batch.channel.config);
  if (!config) return { status: "failed", error: "The channel's settings could not be read." };
  const credentials = await decryptPsaCredentials({ tenantId }, deps.keyProvider, batch.channel);
  const syncro = new SyncroClient({
    credentials: credentials.expose(),
    logger: deps.logger,
    ...(deps.psa?.fetch ? { fetch: deps.psa.fetch } : {}),
    ...(deps.psa?.baseUrl ? { baseUrl: deps.psa.baseUrl } : {}),
  });

  try {
    if (batch.kind === "test") {
      await syncro.me();
      return { status: "sent" };
    }
    if (batch.kind !== "incidents" || !batch.assetId) {
      return { status: "failed", error: "A PSA channel only takes incidents." };
    }
    return await sendIncidents(deps, {
      tenantId,
      batch,
      now,
      syncro,
      config,
      assetId: batch.assetId,
    });
  } catch (error) {
    if (error instanceof PsaError) {
      return { status: error.retryable ? "retry" : "failed", error: error.message };
    }
    throw error;
  }
}

async function sendIncidents(
  deps: PsaDeliveryDeps,
  input: {
    tenantId: string;
    batch: ClaimedBatch;
    now: Date;
    syncro: SyncroClient;
    config: NonNullable<ReturnType<typeof parsePsaConfig>>;
    assetId: string;
  },
): Promise<BatchOutcome> {
  const { tenantId, batch, now, syncro, config, assetId } = input;
  const inTenant = <T>(fn: (context: TenantContext) => Promise<T>) =>
    deps.db.withTenant(tenantId, fn);
  const payload = batch.payload as IncidentsPayload;
  const { opened, closed } = payload.data;
  const first = opened[0] ?? closed[0];
  if (!first) return { status: "sent" };

  const customerId = await inTenant((context) =>
    psaCustomerFor(context, { channelId: batch.channel.id, clientId: first.client.id }),
  );
  if (!customerId) {
    return {
      status: "failed",
      error: `${first.client.name} is no longer matched to a Syncro customer on this channel.`,
    };
  }
  const types = batch.channel.incidentTypes.filter((t): t is RaisedIncidentType =>
    (RAISED_INCIDENT_TYPES as readonly string[]).includes(t),
  );
  const allClear = !(await inTenant((context) =>
    assetHasOpenIncidents(context, { assetId, types }),
  ));
  const news = ticketNews({
    opened,
    closed,
    allClear,
    resolvedStatus: config.resolvedStatus,
    timeZone: batch.timeZone,
    appBaseUrl: deps.appBaseUrl,
  });

  let row = await inTenant((context) =>
    openPsaTicket(context, { channelId: batch.channel.id, assetId }),
  );

  // Closed or deleted in the PSA by hand: a new problem gets a new ticket.
  if (row?.externalTicketId && opened.length > 0 && row.lastBatchId !== batch.id) {
    const current = await syncro.getTicket(row.externalTicketId);
    if (!current || isClosedStatus(current.status, config.resolvedStatus)) {
      const stale = row;
      await inTenant((context) =>
        closePsaTicket(context, { id: stale.id, reason: "closed_in_psa", now }),
      );
      row = null;
    }
  }

  // A create whose answer never came back: find the ticket before making another.
  if (row && !row.externalTicketId) {
    const pending = row;
    const ref = refInSubject(ticketRef(pending.id));
    const since = new Date(pending.createStartedAt.getTime() - 24 * 3_600_000);
    const found = (
      await syncro.findTickets({ customerId: pending.externalCustomerId, createdAfter: since })
    ).find((ticket) => ticket.subject.includes(ref));
    const ticket =
      found ??
      (await syncro.createTicket({
        customerId: pending.externalCustomerId,
        subject: pending.subject,
        problemType: config.problemType ?? undefined,
        comment: news,
      }));
    await inTenant((context) =>
      recordPsaTicketCreated(context, {
        id: pending.id,
        externalTicketId: ticket.id,
        externalTicketNumber: ticket.number || null,
      }),
    );
    // Made now, it carries this message's news. Found, it carries the news
    // of the message that started it, which may be this one or an earlier one.
    row = {
      ...pending,
      externalTicketId: ticket.id,
      lastBatchId: found ? pending.lastBatchId : batch.id,
    };
  }

  if (!row) {
    // Only closings, for an asset with no ticket: nothing to tell the PSA.
    if (opened.length === 0) return { status: "sent" };
    const id = randomUUID();
    let started: PsaTicketRow;
    try {
      started = await inTenant((context) =>
        startPsaTicket(context, {
          id,
          channelId: batch.channel.id,
          assetId,
          externalCustomerId: customerId,
          subject: ticketSubject(opened[0]!, ticketRef(id)),
          batchId: batch.id,
          now,
        }),
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return { status: "retry", error: "Another ticket for this asset was being opened." };
      }
      throw error;
    }
    const ticket = await syncro.createTicket({
      customerId,
      subject: started.subject,
      problemType: config.problemType ?? undefined,
      comment: news,
    });
    await inTenant((context) =>
      recordPsaTicketCreated(context, {
        id: started.id,
        externalTicketId: ticket.id,
        externalTicketNumber: ticket.number || null,
      }),
    );
    row = { ...started, externalTicketId: ticket.id };
  }

  const ticketId = row.externalTicketId!;
  if (row.lastBatchId !== batch.id) {
    await syncro.addComment(ticketId, news);
    const written = row;
    await inTenant((context) =>
      recordPsaTicketNews(context, { id: written.id, batchId: batch.id }),
    );
  }
  if (allClear) {
    await syncro.setStatus(ticketId, config.resolvedStatus);
    const done = row;
    await inTenant((context) => closePsaTicket(context, { id: done.id, reason: "resolved", now }));
  }
  return { status: "sent" };
}
