import type { Logger } from "../logging/logger";
import { ResendEmailSender } from "./resend";

/**
 * Sending an email, whatever the provider. One implementation per provider
 * is all it takes to add one: the rest of the system (rendering, the outbox,
 * retries) does not change.
 */

export interface EmailMessage {
  to: readonly string[];
  subject: string;
  text: string;
  html: string;
  /**
   * The same for every attempt at one message. Providers that support it use
   * it to drop a repeat, as a webhook receiver uses `webhook-id`.
   */
  idempotencyKey: string;
}

export interface EmailSender {
  /** For logs and the settings page: "log", or a provider's name. */
  readonly name: string;
  /** @throws EmailSendError */
  send(message: EmailMessage): Promise<void>;
}

/** A send that did not go through. The message is ours to show; never the provider's response. */
export class EmailSendError extends Error {
  constructor(
    /** Whether trying again later could succeed. */
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = "EmailSendError";
  }
}

/**
 * For local development: writes that an email would have been sent, with
 * its subject and how many recipients, and sends nothing. Refused in
 * production, where it would silently swallow every notification.
 */
export class LogEmailSender implements EmailSender {
  readonly name = "log";
  constructor(private readonly logger: Logger) {}

  async send(message: EmailMessage): Promise<void> {
    this.logger.info(
      { subject: message.subject, recipients: message.to.length, key: message.idempotencyKey },
      "email not sent: the development email sender only logs",
    );
  }
}

/** For tests: keeps every message, and can be told to fail. */
export class MemoryEmailSender implements EmailSender {
  readonly name = "memory";
  readonly sent: EmailMessage[] = [];
  failure: EmailSendError | null = null;

  async send(message: EmailMessage): Promise<void> {
    if (this.failure) throw this.failure;
    this.sent.push(message);
  }
}

/**
 * The sender this process is configured with, or null when email is not set
 * up. Fails at startup on a value it does not know, rather than at the first
 * notification.
 */
export function createEmailSenderFromEnv(
  env: {
    NODE_ENV?: string | undefined;
    EMAIL_PROVIDER?: string | undefined;
    RESEND_API_KEY?: string | undefined;
    EMAIL_FROM?: string | undefined;
    EMAIL_REPLY_TO?: string | undefined;
  },
  logger: Logger,
): EmailSender | null {
  const provider = env.EMAIL_PROVIDER?.trim() ?? "";
  if (provider === "") return null;
  if (provider === "log") {
    if (env.NODE_ENV === "production") {
      throw new Error(
        "EMAIL_PROVIDER=log only logs and sends nothing; it cannot be used in production.",
      );
    }
    return new LogEmailSender(logger);
  }
  if (provider === "resend") {
    const apiKey = env.RESEND_API_KEY?.trim();
    if (!apiKey) throw new Error("EMAIL_PROVIDER=resend needs RESEND_API_KEY.");
    if (!env.EMAIL_FROM?.trim()) {
      throw new Error(
        'EMAIL_PROVIDER=resend needs EMAIL_FROM: an address, or "Name <address>", on a domain verified in Resend.',
      );
    }
    const replyTo = env.EMAIL_REPLY_TO?.trim();
    return new ResendEmailSender({
      apiKey,
      from: env.EMAIL_FROM,
      ...(replyTo ? { replyTo } : {}),
      logger,
    });
  }
  throw new Error(
    `EMAIL_PROVIDER: unknown provider. Leave it empty, or set it to "resend" (or "log" outside production).`,
  );
}

/** Bounds on an email channel's recipients. */
export const MAX_EMAIL_RECIPIENTS = 20;
