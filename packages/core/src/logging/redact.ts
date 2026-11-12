import { Secret } from "../crypto/secret";

export const REDACTED = "[redacted]";

/**
 * Property names whose values never reach a log, at any depth. Matched
 * case-insensitively against the whole key with separators removed, so
 * `secretKey`, `secret_key` and `Secret-Key` are all caught.
 */
const SENSITIVE_KEY =
  /^pass$|password|passwd|passphrase|secret|token|authorization|apikey|publickey|privatekey|credential|cookie|rawpayload|ciphertext|wrappedkey|datakey|^kek$|^dek$|^headers$/;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key.toLowerCase().replace(/[^a-z0-9]/g, ""));
}

/**
 * Removes credentials that appear inside free text: HTTP auth schemes, the
 * user:password part of a URL, and common key=value secrets in query strings.
 * A second line of defence for messages and error text, where there is no
 * property name to go by.
 */
export function scrubString(text: string): string {
  return text
    .replace(/\b(Basic|Bearer)\s+[A-Za-z0-9+/._~=-]{6,}/gi, `$1 ${REDACTED}`)
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, `$1${REDACTED}@`)
    .replace(
      /\b(api[_-]?key|secret[_-]?key|access[_-]?token|token|password|secret)=([^&\s"']+)/gi,
      `$1=${REDACTED}`,
    );
}

const MAX_DEPTH = 8;

/**
 * Returns a copy of `value` that is safe to log: sensitive properties are
 * replaced, strings are scrubbed, errors are flattened, and anything too deep
 * or circular is cut off. Never mutates its input.
 */
export function redact(value: unknown): unknown {
  return walk(value, 0, new WeakSet());
}

function walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return scrubString(value);
  if (value === null || typeof value !== "object") {
    return typeof value === "bigint" ? value.toString() : value;
  }
  if (value instanceof Secret) return REDACTED;
  if (value instanceof Date) return value;
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return "[binary]";
  if (seen.has(value)) return "[circular]";
  if (depth >= MAX_DEPTH) return "[truncated]";
  seen.add(value);

  if (value instanceof Error) {
    const flat: Record<string, unknown> = {
      type: value.name,
      message: scrubString(value.message),
    };
    if (value.stack) flat.stack = scrubString(value.stack);
    const extra = value as Error & { code?: unknown; status?: unknown };
    if (extra.code !== undefined) flat.code = walk(extra.code, depth + 1, seen);
    if (extra.status !== undefined) flat.status = walk(extra.status, depth + 1, seen);
    if (value.cause !== undefined) flat.cause = walk(value.cause, depth + 1, seen);
    return flat;
  }

  if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1, seen));

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? REDACTED : walk(child, depth + 1, seen);
  }
  return out;
}
