import {
  DecryptionError,
  EmailSendError,
  OutboundFailedError,
  KeyServiceUnavailableError,
  OutboundRefusedError,
  postJson,
  signWebhook,
  type EmailSender,
  type KeyProvider,
  type Logger,
  type OutboundPolicy,
  type Resolver,
} from "@valtrexia/core/server";
import { brand, renderNotificationEmail, type NotificationPayload } from "@valtrexia/core";
import {
  claimNotificationBatch,
  decryptChannelDestination,
  finishNotificationBatch,
  type BatchOutcome,
  type ClaimedBatch,
  type Db,
} from "@valtrexia/db";
import { sendToPsa } from "./psa";

/**
 * Sends what the outbox holds.
 *
 * Each batch is claimed in a short transaction, sent with no transaction
 * open, and its outcome recorded in another. Claiming pushes the batch's
 * next attempt past a lease, so two workers never send it at once; if a
 * worker dies mid-send, the lease runs out and the batch is tried again.
 *
 * That means a receiver can, rarely, get the same message twice: when the
 * send succeeded but the worker died before recording it. Every attempt at
 * one message carries the same `webhook-id`, so a receiver can recognize a
 * repeat. Exactly-once delivery is not something any sender can promise.
 */

/** How long a claimed batch is reserved for the worker sending it. Longer than any send can take. */
export const DELIVERY_LEASE_MS = 2 * 60_000;
/** Identifies our requests in a receiver's logs. */
const WEBHOOK_USER_AGENT = `${brand.name}-Webhooks/1`;

/** Batches sent at the same time by one worker. */
export const DELIVERY_CONCURRENCY = 5;

export interface DeliveryDeps {
  db: Db;
  keyProvider: KeyProvider;
  logger: Logger;
  /** What tenant-supplied destinations may be. Strict unless set for local development. */
  outboundPolicy: OutboundPolicy;
  /** How email is sent, or null when this server has no email set up. */
  emailSender: EmailSender | null;
  /** Where the web app is served, for links in emails. */
  appBaseUrl?: string | undefined;
  now?: () => Date;
  /** Replaces DNS. For tests. */
  resolver?: Resolver;
  /** How long one webhook request may take. Default 10 seconds. */
  timeoutMs?: number;
  /** For tests: a stand-in PSA. */
  psa?: { fetch?: typeof fetch; baseUrl?: string };
}

export interface DeliveryResult {
  batchId: string;
  result: "sent" | "retrying" | "failed" | "skipped";
}

/** What an HTTP status means for this message. */
export function outcomeOfStatus(status: number): BatchOutcome {
  if (status >= 200 && status < 300) return { status: "sent" };
  if (status === 410) {
    return {
      status: "failed",
      error: "The endpoint said it no longer exists (HTTP 410). Check the channel's URL.",
    };
  }
  return { status: "retry", error: `The endpoint answered with HTTP ${status}.` };
}

/** What a failure to send means for this message. Only messages we wrote are kept. */
export function outcomeOfError(error: unknown): BatchOutcome {
  if (error instanceof OutboundRefusedError) return { status: "failed", error: error.message };
  if (error instanceof OutboundFailedError) return { status: "retry", error: error.message };
  if (error instanceof EmailSendError) {
    return { status: error.retryable ? "retry" : "failed", error: error.message };
  }
  if (error instanceof DecryptionError) {
    return {
      status: "failed",
      error: "The channel's saved destination could not be read. Set the channel up again.",
    };
  }
  if (error instanceof KeyServiceUnavailableError) {
    return {
      status: "retry",
      error:
        "The channel's destination could not be read: the encryption key service could not be reached.",
    };
  }
  return { status: "retry", error: "Sending failed unexpectedly." };
}

async function send(deps: DeliveryDeps, tenantId: string, batch: ClaimedBatch, now: Date) {
  if (!batch.channel.enabled) {
    return {
      status: "failed",
      error: "The channel was turned off before this was sent.",
    } satisfies BatchOutcome;
  }
  if (batch.channel.type === "email") return sendEmail(deps, batch);
  if (batch.channel.type === "psa") {
    try {
      return await sendToPsa(deps, tenantId, batch, now);
    } catch (error) {
      return outcomeOfError(error);
    }
  }
  try {
    const destination = (
      await decryptChannelDestination({ tenantId }, deps.keyProvider, batch.channel)
    ).expose();
    const body = JSON.stringify(batch.payload);
    const headers = signWebhook({ id: batch.id, timestamp: now, body }, destination.signingSecret);
    const { status } = await postJson(destination.url, {
      body,
      headers: { ...headers, "user-agent": WEBHOOK_USER_AGENT },
      policy: deps.outboundPolicy,
      ...(deps.resolver ? { resolver: deps.resolver } : {}),
      ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}),
    });
    return outcomeOfStatus(status);
  } catch (error) {
    return outcomeOfError(error);
  }
}

function recipientsOf(config: unknown): string[] {
  const value = (config as { recipients?: unknown } | null)?.recipients;
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

async function sendEmail(deps: DeliveryDeps, batch: ClaimedBatch): Promise<BatchOutcome> {
  if (!deps.emailSender) {
    return { status: "failed", error: "Email is not set up on this server." };
  }
  const to = recipientsOf(batch.channel.config);
  if (to.length === 0) return { status: "failed", error: "The channel has no recipients." };
  try {
    const email = renderNotificationEmail(batch.payload as NotificationPayload, {
      timeZone: batch.timeZone,
      channelName: batch.channel.name,
      ...(deps.appBaseUrl ? { appBaseUrl: deps.appBaseUrl } : {}),
    });
    await deps.emailSender.send({ to, ...email, idempotencyKey: batch.id });
    return { status: "sent" };
  } catch (error) {
    return outcomeOfError(error);
  }
}

/** Sends one batch, if it is still due and nobody else has taken it. */
export async function deliverBatch(
  deps: DeliveryDeps,
  target: { tenantId: string; batchId: string },
): Promise<DeliveryResult> {
  const now = (deps.now ?? (() => new Date()))();
  const batch = await deps.db.withTenant(target.tenantId, (context) =>
    claimNotificationBatch(context, { batchId: target.batchId, now, leaseMs: DELIVERY_LEASE_MS }),
  );
  if (!batch) return { batchId: target.batchId, result: "skipped" };

  const outcome = await send(deps, target.tenantId, batch, now);
  const finishedAt = (deps.now ?? (() => new Date()))();
  const result = await deps.db.withTenant(target.tenantId, (context) =>
    finishNotificationBatch(context, {
      batchId: batch.id,
      attempts: batch.attempts,
      now: finishedAt,
      outcome,
    }),
  );

  // Ids and outcomes only: never the destination, the body or the secret.
  const fields = {
    batchId: batch.id,
    channelId: batch.channel.id,
    kind: batch.kind,
    attempt: batch.attempts,
    result,
    ...(outcome.status === "sent" ? {} : { error: outcome.error }),
  };
  if (result === "failed") deps.logger.warn(fields, "notification not delivered");
  else
    deps.logger.info(
      fields,
      result === "sent" ? "notification sent" : "notification will be retried",
    );
  return { batchId: batch.id, result };
}

/** Sends every batch that is due now, a few at a time. */
export async function deliverDueNotifications(deps: DeliveryDeps): Promise<DeliveryResult[]> {
  const due = await deps.db.listDueNotificationBatches();
  const results: DeliveryResult[] = [];
  for (let i = 0; i < due.length; i += DELIVERY_CONCURRENCY) {
    const slice = due.slice(i, i + DELIVERY_CONCURRENCY);
    results.push(
      ...(await Promise.all(
        slice.map((target) =>
          deliverBatch(deps, target).catch((error: unknown) => {
            // One failure must not stop the rest. The batch stays claimed
            // until its lease runs out, then is tried again.
            deps.logger.error(
              { err: error, batchId: target.batchId },
              "notification delivery failed",
            );
            return { batchId: target.batchId, result: "skipped" as const };
          }),
        ),
      )),
    );
  }
  return results;
}
