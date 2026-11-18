import { MAX_EMAIL_RECIPIENTS } from "../notifications/email-sender";

/** Where alerts about the service itself go. Both may be set; neither means nobody is told. */
export interface OperatorAlertConfig {
  emails: string[];
  webhookUrl: string | null;
  /** Signs webhook requests (Standard Webhooks) when set. Slack's incoming webhooks need none. */
  webhookSecret: string | null;
}

const ADDRESS = /^[^\s@<>"(),;:]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

/**
 * Reads OPERATOR_ALERT_EMAIL (comma-separated), OPERATOR_ALERT_WEBHOOK_URL and
 * OPERATOR_ALERT_WEBHOOK_SECRET. Throws, naming the setting but never its
 * value, if one is malformed.
 */
export function operatorAlertConfigFromEnv(
  env: Record<string, string | undefined>,
): OperatorAlertConfig {
  const emails = (env.OPERATOR_ALERT_EMAIL ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (emails.some((email) => !ADDRESS.test(email))) {
    throw new Error(
      "OPERATOR_ALERT_EMAIL must be one or more email addresses, separated by commas.",
    );
  }
  if (emails.length > MAX_EMAIL_RECIPIENTS) {
    throw new Error(`OPERATOR_ALERT_EMAIL can name at most ${MAX_EMAIL_RECIPIENTS} addresses.`);
  }

  const url = env.OPERATOR_ALERT_WEBHOOK_URL?.trim() || null;
  if (url) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(url);
    } catch {
      parsed = null;
    }
    if (!parsed || parsed.protocol !== "https:" || parsed.username || parsed.password) {
      throw new Error(
        "OPERATOR_ALERT_WEBHOOK_URL must be an https:// URL without a user name or password.",
      );
    }
  }

  const secret = env.OPERATOR_ALERT_WEBHOOK_SECRET?.trim() || null;
  if (secret && !/^whsec_[A-Za-z0-9+/]{32,}={0,2}$/.test(secret)) {
    throw new Error(
      'OPERATOR_ALERT_WEBHOOK_SECRET must be a signing secret starting with "whsec_".',
    );
  }
  if (secret && !url) {
    throw new Error("OPERATOR_ALERT_WEBHOOK_SECRET is set without OPERATOR_ALERT_WEBHOOK_URL.");
  }

  return {
    emails: [...new Set(emails.map((e) => e.toLowerCase()))],
    webhookUrl: url,
    webhookSecret: secret,
  };
}
