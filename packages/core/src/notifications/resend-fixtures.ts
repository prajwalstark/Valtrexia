import { RESEND_API_URL } from "./resend";

/**
 * A stand-in for Resend's send endpoint, for tests, built from its API
 * reference: `POST /emails` with a bearer key and a User-Agent; at most 50
 * recipients; an `Idempotency-Key` of 1 to 256 characters, under which a
 * repeat with the same body gets the first answer without sending again,
 * and a repeat with a different body gets 409 `invalid_idempotent_request`.
 * Errors have Resend's shape: `{ statusCode, name, message }`.
 */
export const FAKE_RESEND_KEY = "re_fake_0123456789abcdefghijklmnop";

export interface FakeResend {
  fetch: typeof fetch;
  /** Emails actually sent: once per accepted, non-repeated request. */
  delivered: {
    from: string;
    to: string[];
    subject: string;
    html: string;
    text: string;
    reply_to?: string;
  }[];
  /** Every request, as received. */
  requests: { method: string; url: string; headers: Headers; body: string }[];
  /** Makes the next requests fail with these, in order. */
  failNext(...failures: { status: number; name: string; message?: string }[]): void;
}

export function fakeResend(options: { key?: string } = {}): FakeResend {
  const key = options.key ?? FAKE_RESEND_KEY;
  const delivered: FakeResend["delivered"] = [];
  const requests: FakeResend["requests"] = [];
  const failures: { status: number; name: string; message?: string }[] = [];
  const seen = new Map<string, { body: string; id: string }>();
  const error = (statusCode: number, name: string, message = name) =>
    Response.json({ statusCode, name, message }, { status: statusCode });

  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : "";
    requests.push({ method, url, headers, body });

    const failure = failures.shift();
    if (failure) return error(failure.status, failure.name, failure.message);
    if (url !== RESEND_API_URL) return error(404, "not_found");
    if (method !== "POST") return error(405, "method_not_allowed");
    if (!headers.get("user-agent")) return error(403, "validation_error", "User-Agent required");
    const auth = headers.get("authorization");
    if (!auth) return error(401, "missing_api_key", "Missing API Key");
    if (auth !== `Bearer ${key}`) return error(401, "validation_error", "API key is invalid");

    const idempotency = headers.get("idempotency-key");
    if (idempotency !== null && (idempotency.length < 1 || idempotency.length > 256)) {
      return error(400, "invalid_idempotency_key");
    }
    let parsed: FakeResend["delivered"][number];
    try {
      parsed = JSON.parse(body) as FakeResend["delivered"][number];
    } catch {
      return error(400, "validation_error");
    }
    if (!parsed.from || !parsed.subject || !parsed.to) return error(422, "missing_required_field");
    if (!Array.isArray(parsed.to) || parsed.to.length < 1 || parsed.to.length > 50) {
      return error(422, "validation_error");
    }
    if (idempotency) {
      const previous = seen.get(idempotency);
      if (previous && previous.body !== body) return error(409, "invalid_idempotent_request");
      if (previous) return Response.json({ id: previous.id });
    }
    const id = crypto.randomUUID();
    if (idempotency) seen.set(idempotency, { body, id });
    delivered.push(parsed);
    return Response.json({ id });
  }) as typeof fetch;

  return { fetch: fetchImpl, delivered, requests, failNext: (...f) => void failures.push(...f) };
}
