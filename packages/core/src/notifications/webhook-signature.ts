import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Webhook signing, following the Standard Webhooks specification
 * (standardwebhooks.com), so a receiver can verify our requests with an
 * existing library instead of code written for us alone.
 *
 * Three headers go with every request:
 *   webhook-id         a stable id for the message, the same on every retry,
 *                      so a receiver can ignore one it has already handled;
 *   webhook-timestamp  when this attempt was made, in seconds;
 *   webhook-signature  "v1," followed by the base64 HMAC-SHA256 of
 *                      "<id>.<timestamp>.<body>" under the channel's secret.
 */

const SECRET_PREFIX = "whsec_";
const SECRET_BYTES = 32;

/** A new signing secret: "whsec_" followed by 32 random bytes in base64. */
export function generateWebhookSecret(): string {
  return SECRET_PREFIX + randomBytes(SECRET_BYTES).toString("base64");
}

function keyOf(secret: string): Buffer {
  if (!secret.startsWith(SECRET_PREFIX)) throw new Error("Invalid webhook signing secret.");
  const key = Buffer.from(secret.slice(SECRET_PREFIX.length), "base64");
  if (key.length < 24) throw new Error("Invalid webhook signing secret.");
  return key;
}

export interface WebhookMessage {
  /** Stable for the message across retries. */
  id: string;
  /** When this attempt is being sent. */
  timestamp: Date;
  /** The exact bytes of the request body. */
  body: string;
}

/** The three headers to send with a webhook request. */
export function signWebhook(message: WebhookMessage, secret: string): Record<string, string> {
  const seconds = Math.floor(message.timestamp.getTime() / 1000);
  const signature = createHmac("sha256", keyOf(secret))
    .update(`${message.id}.${seconds}.${message.body}`)
    .digest("base64");
  return {
    "webhook-id": message.id,
    "webhook-timestamp": String(seconds),
    "webhook-signature": `v1,${signature}`,
  };
}

/**
 * What a receiver does with those headers. Here for our own tests and as a
 * reference for anyone writing a receiver by hand: check the signature in
 * constant time, and refuse a timestamp too far from now, so a captured
 * request cannot be replayed later.
 */
export function verifyWebhook(
  headers: Record<string, string | undefined>,
  body: string,
  secret: string,
  options: { now?: Date; toleranceSeconds?: number } = {},
): boolean {
  const id = headers["webhook-id"];
  const timestamp = headers["webhook-timestamp"];
  const given = headers["webhook-signature"];
  if (!id || !timestamp || !given || !/^\d+$/.test(timestamp)) return false;

  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (Math.abs(now - Number(timestamp)) > (options.toleranceSeconds ?? 300)) return false;

  const expected = createHmac("sha256", keyOf(secret))
    .update(`${id}.${timestamp}.${body}`)
    .digest();
  // The header may carry several signatures, space-separated, during a secret rotation.
  return given.split(" ").some((candidate) => {
    const [version, value] = candidate.split(",");
    if (version !== "v1" || !value) return false;
    const actual = Buffer.from(value, "base64");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}
