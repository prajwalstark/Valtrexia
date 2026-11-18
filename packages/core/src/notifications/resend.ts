import { createHash } from "node:crypto";
import { brand } from "../brand";
import type { Logger } from "../logging/logger";
import { EmailSendError, type EmailMessage, type EmailSender } from "./email-sender";

/**
 * Sends email through Resend's HTTP API (https://resend.com/docs/api-reference),
 * with nothing but `fetch`: one request per message to a fixed address.
 *
 * Retries are the outbox's job, not this class's: it makes one attempt and
 * says whether trying again later could help. Resend's idempotency key makes
 * a retry of a message that did reach Resend a no-op, for 24 hours.
 */

export const RESEND_API_URL = "https://api.resend.com/emails";

/** Resend accepts up to 50 recipients per message; channels are capped lower anyway. */
const MAX_RECIPIENTS = 50;

export interface ResendOptions {
  apiKey: string;
  /** The sender: `alerts@example.com`, or `Name <alerts@example.com>`. Its domain must be verified in Resend. */
  from: string;
  /** Where replies go, if not to the sender. */
  replyTo?: string;
  logger?: Logger;
  fetch?: typeof fetch;
  /** Overrides Resend's address. Tests only. */
  url?: string;
  timeoutMs?: number;
}

/**
 * Error types from Resend's errors reference that a later attempt can get
 * past: a busy repeat, rate and quota limits, and outages.
 */
const RETRYABLE_TYPES = new Set([
  "concurrent_idempotent_requests",
  "rate_limit_exceeded",
  "daily_quota_exceeded",
  "monthly_quota_exceeded",
  "application_error",
  "service_unavailable",
  "dns_lookup_failed",
]);

export class ResendEmailSender implements EmailSender {
  readonly name = "resend";
  readonly #apiKey: string;
  readonly #from: string;
  readonly #replyTo: string | undefined;
  readonly #logger: Logger | undefined;
  readonly #fetch: typeof fetch;
  readonly #url: string;
  readonly #timeoutMs: number;

  constructor(options: ResendOptions) {
    if (!options.apiKey.trim()) throw new Error("A Resend API key is required.");
    const from = parseSender(options.from);
    if (!from) throw new Error(senderProblem("EMAIL_FROM"));
    if (options.replyTo !== undefined && !parseSender(options.replyTo)) {
      throw new Error(senderProblem("EMAIL_REPLY_TO"));
    }
    this.#apiKey = options.apiKey.trim();
    this.#from = from;
    this.#replyTo = options.replyTo?.trim();
    this.#logger = options.logger;
    this.#fetch = options.fetch ?? fetch;
    this.#url = options.url ?? RESEND_API_URL;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  async send(message: EmailMessage): Promise<void> {
    if (message.to.length === 0 || message.to.length > MAX_RECIPIENTS) {
      throw new EmailSendError(false, `A message needs 1 to ${MAX_RECIPIENTS} recipients.`);
    }
    const body = JSON.stringify({
      from: this.#from,
      to: [...message.to],
      subject: message.subject,
      html: message.html,
      text: message.text,
      ...(this.#replyTo ? { reply_to: this.#replyTo } : {}),
    });

    let response: Response;
    try {
      response = await this.#fetch(this.#url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
          // Resend refuses requests without one.
          "user-agent": `${brand.name}-Email/1`,
          "idempotency-key": idempotencyKey(message.idempotencyKey, body),
        },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (cause) {
      const timedOut =
        cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
      throw new EmailSendError(
        true,
        timedOut
          ? "The email service did not answer in time."
          : "The email service could not be reached.",
      );
    }

    if (response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return;
    }

    const type = await errorType(response);
    // The status and Resend's error type are safe to log; its message is not
    // (it can quote recipients' addresses), and the body is never read beyond the type.
    this.#logger?.warn({ status: response.status, type }, "email service refused a message");
    throw failureFor(response.status, type);
  }
}

/** What a refusal means for this message, in words for the notifications page. */
export function failureFor(status: number, type: string | null): EmailSendError {
  if (type === "daily_quota_exceeded" || type === "monthly_quota_exceeded") {
    return new EmailSendError(true, "The email service's sending quota is used up for now.");
  }
  if (status === 429 || type === "rate_limit_exceeded") {
    return new EmailSendError(true, "The email service is limiting how fast this server sends.");
  }
  if ((type && RETRYABLE_TYPES.has(type)) || status >= 500) {
    return new EmailSendError(true, "The email service had a problem. It will be tried again.");
  }
  if (status === 401 || status === 403) {
    // A key that is wrong, revoked or suspended, or a sender domain that is
    // not verified: the operator's to fix, and worth trying again once fixed.
    return new EmailSendError(
      true,
      "The email service refused this server's credentials or sender address. The operator needs to fix the email settings.",
    );
  }
  return new EmailSendError(false, "The email service refused the message as invalid.");
}

/** The `name` of a Resend error body, or null. Reads at most a small body. */
async function errorType(response: Response): Promise<string | null> {
  try {
    const text = (await response.text()).slice(0, 4_096);
    const parsed = JSON.parse(text) as { name?: unknown };
    return typeof parsed.name === "string" && /^[a-z_]{1,64}$/.test(parsed.name)
      ? parsed.name
      : null;
  } catch {
    return null;
  }
}

/**
 * The key Resend uses to drop a repeat: the message's own id and a hash of
 * exactly what is sent. A retry of the same message dedupes. If its wording
 * changed in between (a renamed channel, a new time zone), the key changes
 * too, and the message is sent rather than refused as a mismatched repeat.
 */
export function idempotencyKey(messageId: string, body: string): string {
  const digest = createHash("sha256").update(body).digest("hex").slice(0, 32);
  return `${messageId.slice(0, 200)}:${digest}`;
}

/**
 * A sender as Resend takes it: a bare address, or `Name <address>`. Null if
 * it is neither, or could smuggle in a header (line breaks, angle brackets in
 * the name, quotes).
 */
export function parseSender(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 320 || /[\r\n\0]/.test(trimmed)) return null;
  const address = /^[^\s@<>"(),;:]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
  if (address.test(trimmed)) return trimmed;
  const named = /^([^<>"\\]{1,100}?)\s*<([^<>\s]+)>$/.exec(trimmed);
  if (named && address.test(named[2]!)) return `${named[1]!.trim()} <${named[2]}>`;
  return null;
}

function senderProblem(variable: string): string {
  return `${variable} must be an email address, or "Name <address>", on a domain verified in Resend.`;
}
