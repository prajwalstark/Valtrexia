import type { Logger } from "@valtrexia/core/server";
import {
  AuthError,
  InvalidResponseError,
  NetworkError,
  RateLimitError,
  VendorError,
} from "./errors";

export interface HttpClientOptions {
  /** API root. Every request must stay on this origin and under this path. */
  baseUrl: string;
  /** Headers sent with every request, typically authentication. Never logged. */
  headers?: () => Record<string, string>;
  fetch?: typeof fetch;
  logger?: Logger;
  /** Retries after the first attempt. Default 4. */
  maxRetries?: number;
  /** First backoff ceiling; doubles each retry. Default 500 ms. */
  baseDelayMs?: number;
  /** Largest backoff between retries. Default 30 s. */
  maxDelayMs?: number;
  /** Longest Retry-After we will wait in-process. Past this we give up for now. Default 60 s. */
  maxRetryAfterMs?: number;
  /** Per-attempt timeout. Default 30 s. */
  timeoutMs?: number;
  /** Requests in flight at once. Default 4. */
  maxConcurrency?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

export type Query = Record<string, string | number | boolean | undefined>;

/**
 * HTTP client for vendor APIs.
 *
 * - GET only. There is no way to issue a write through it, which is what
 *   makes the connectors read-only.
 * - Retries network failures, timeouts, 5xx and 429 with exponential backoff
 *   and full jitter; honours Retry-After.
 * - Never follows a request off the configured origin, so a crafted
 *   pagination link cannot send credentials elsewhere.
 * - Logs method, path, status and timing. Never headers, never bodies.
 */
export interface HttpClient {
  getJson(path: string, query?: Query): Promise<unknown>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createHttpClient(options: HttpClientOptions): HttpClient {
  const {
    headers = () => ({}),
    logger,
    maxRetries = 4,
    baseDelayMs = 500,
    maxDelayMs = 30_000,
    maxRetryAfterMs = 60_000,
    timeoutMs = 30_000,
    maxConcurrency = 4,
    sleep = defaultSleep,
    random = Math.random,
    now = Date.now,
  } = options;
  const doFetch = options.fetch ?? fetch;

  const base = new URL(options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`);
  if (
    base.protocol !== "https:" &&
    base.hostname !== "localhost" &&
    base.hostname !== "127.0.0.1"
  ) {
    throw new Error("Vendor API base URL must use https.");
  }
  if (base.username || base.password) {
    throw new Error("Vendor API base URL must not contain credentials.");
  }

  function resolve(path: string, query?: Query): URL {
    // A leading slash would discard the base path, and an absolute URL would
    // discard the origin. Refuse both instead of guessing.
    if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//") || path.startsWith("/")) {
      throw new Error("Request path must be relative to the API base URL.");
    }
    const url = new URL(path, base);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
      throw new Error("Request path must stay under the API base URL.");
    }
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url;
  }

  // A small counting semaphore: at most `maxConcurrency` requests in flight.
  let active = 0;
  const waiting: (() => void)[] = [];
  async function acquire(): Promise<void> {
    if (active < maxConcurrency) {
      active += 1;
      return;
    }
    await new Promise<void>((next) => waiting.push(next));
  }
  function release(): void {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  }

  /** Exponential backoff with full jitter. */
  function backoff(attempt: number): number {
    const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
    return Math.floor(random() * ceiling);
  }

  /** Retry-After as milliseconds: either delta-seconds or an HTTP date. */
  function retryAfter(response: Response): number | null {
    const header = response.headers.get("retry-after");
    if (!header) return null;
    if (/^\d+(\.\d+)?$/.test(header.trim())) return Math.ceil(Number(header) * 1000);
    const date = Date.parse(header);
    return Number.isNaN(date) ? null : Math.max(0, date - now());
  }

  async function attemptOnce(url: URL): Promise<Response> {
    try {
      return await doFetch(url, {
        method: "GET",
        headers: { accept: "application/json", ...headers() },
        // A redirect could carry the request, and its credentials, elsewhere.
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      const timedOut =
        cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
      // The cause is kept for debugging but its text is not put in the message.
      throw new NetworkError(timedOut, { cause });
    }
  }

  async function getJson(path: string, query?: Query): Promise<unknown> {
    const url = resolve(path, query);
    const logPath = url.pathname;

    await acquire();
    try {
      for (let attempt = 0; ; attempt += 1) {
        const started = now();
        let response: Response;
        try {
          response = await attemptOnce(url);
        } catch (error) {
          if (!(error instanceof NetworkError) || attempt >= maxRetries) throw error;
          const delay = backoff(attempt);
          logger?.warn(
            { path: logPath, attempt, delayMs: delay },
            "vendor request failed, retrying",
          );
          await sleep(delay);
          continue;
        }

        const status = response.status;
        logger?.debug({ path: logPath, status, attempt, ms: now() - started }, "vendor request");

        if (status >= 200 && status < 300) {
          try {
            return (await response.json()) as unknown;
          } catch {
            throw new InvalidResponseError("body is not JSON");
          }
        }

        // Free the connection before deciding what to do next.
        await response.body?.cancel().catch(() => undefined);

        if (status === 401 || status === 403) throw new AuthError(status);

        if (status === 429) {
          const wait = retryAfter(response);
          if (attempt >= maxRetries || (wait !== null && wait > maxRetryAfterMs)) {
            throw new RateLimitError(wait);
          }
          const delay = wait ?? backoff(attempt);
          logger?.warn({ path: logPath, attempt, delayMs: delay }, "vendor rate limit, waiting");
          await sleep(delay);
          continue;
        }

        if (status >= 500 || status === 408) {
          if (attempt >= maxRetries) throw new VendorError(status);
          const wait = retryAfter(response);
          const delay = wait !== null && wait <= maxRetryAfterMs ? wait : backoff(attempt);
          logger?.warn(
            { path: logPath, status, attempt, delayMs: delay },
            "vendor error, retrying",
          );
          await sleep(delay);
          continue;
        }

        // Other 4xx, and 3xx (redirects are not followed): not retryable.
        throw new VendorError(status);
      }
    } finally {
      release();
    }
  }

  return { getJson };
}

export interface Page<T> {
  items: T[];
  /** Total number of pages, when the vendor reports it. */
  totalPages: number | null;
}

/**
 * Collects every item from a page-numbered endpoint. Stops at the reported
 * last page, or at the first empty page when the vendor does not report one.
 * `maxPages` bounds the loop in case a vendor keeps returning data forever.
 */
export async function collectPages<T>(
  fetchPage: (page: number) => Promise<Page<T>>,
  options: { firstPage?: number; maxPages?: number } = {},
): Promise<T[]> {
  const firstPage = options.firstPage ?? 1;
  const maxPages = options.maxPages ?? 1000;
  const all: T[] = [];

  for (let index = 0; index < maxPages; index += 1) {
    const page = firstPage + index;
    const { items, totalPages } = await fetchPage(page);
    all.push(...items);
    if (items.length === 0) return all;
    if (totalPages !== null && index + 1 >= totalPages) return all;
  }
  throw new InvalidResponseError(`pagination did not end after ${maxPages} pages`);
}
