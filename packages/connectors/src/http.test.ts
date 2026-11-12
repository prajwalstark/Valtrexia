import { Writable } from "node:stream";
import { createLogger } from "@valtrexia/core/server";
import { describe, expect, it } from "vitest";
import {
  AuthError,
  InvalidResponseError,
  NetworkError,
  RateLimitError,
  VendorError,
} from "./errors";
import { collectPages, createHttpClient, type HttpClientOptions } from "./http";

const BASE = "https://api.vendor.test/v1";

type Step = Response | Error | (() => Response | Promise<Response>);

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
const status = (code: number, headers: Record<string, string> = {}) =>
  new Response("error body that must never be surfaced", { status: code, headers });

/** A client wired to a scripted fetch, with sleeps recorded instead of waited. */
function harness(steps: Step[], options: Partial<HttpClientOptions> = {}) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const sleeps: number[] = [];
  const fakeFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const step = steps.shift();
    if (!step) throw new Error("fetch called more times than scripted");
    if (step instanceof Error) throw step;
    return typeof step === "function" ? step() : step;
  }) as typeof fetch;

  const client = createHttpClient({
    baseUrl: BASE,
    fetch: fakeFetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    now: () => Date.parse("2026-11-12T12:00:00Z"),
    ...options,
  });
  return { client, calls, sleeps };
}

describe("http client: requests", () => {
  it("issues a GET under the base URL with query parameters and the auth header", async () => {
    const { client, calls } = harness([json({ ok: true })], {
      headers: () => ({ authorization: "Basic fixture" }),
    });
    await expect(
      client.getJson("bcdr/device", { _page: 2, _perPage: 50, skip: undefined }),
    ).resolves.toEqual({
      ok: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.vendor.test/v1/bcdr/device?_page=2&_perPage=50");
    expect(calls[0]!.init?.method).toBe("GET");
    expect(calls[0]!.init?.redirect).toBe("manual");
    expect(calls[0]!.init?.headers).toMatchObject({
      accept: "application/json",
      authorization: "Basic fixture",
    });
  });

  it("is read-only: the only thing it can do is GET", () => {
    const { client } = harness([]);
    expect(Object.keys(client)).toEqual(["getJson"]);
  });

  it.each([
    ["an absolute URL", "https://evil.test/steal"],
    ["a protocol-relative URL", "//evil.test/steal"],
    ["a root-relative path", "/other-api/device"],
    ["a path that climbs out of the base", "../../admin"],
  ])("refuses %s, so credentials cannot be sent elsewhere", async (_label, path) => {
    const { client, calls } = harness([json({})]);
    await expect(client.getJson(path)).rejects.toThrow(/API base URL/);
    expect(calls).toHaveLength(0);
  });

  it("requires https, except for localhost, and no credentials in the URL", () => {
    expect(() => createHttpClient({ baseUrl: "http://api.vendor.test/v1" })).toThrow(/https/);
    expect(() => createHttpClient({ baseUrl: "http://localhost:4010/v1" })).not.toThrow();
    expect(() => createHttpClient({ baseUrl: "https://user:pw@api.vendor.test" })).toThrow(
      /must not contain credentials/,
    );
  });

  it("does not follow redirects", async () => {
    const { client, calls } = harness([status(302, { location: "https://elsewhere.test/" })]);
    await expect(client.getJson("device")).rejects.toBeInstanceOf(VendorError);
    expect(calls).toHaveLength(1);
  });
});

describe("http client: retries and backoff", () => {
  it("retries 5xx with exponential backoff and jitter, then succeeds", async () => {
    const { client, calls, sleeps } = harness([status(503), status(502), status(500), json([1])]);
    await expect(client.getJson("device")).resolves.toEqual([1]);
    expect(calls).toHaveLength(4);
    // random() is fixed at 0.5: half of 500, 1000, 2000.
    expect(sleeps).toEqual([250, 500, 1000]);
  });

  it("caps the backoff at the configured maximum", async () => {
    const steps: Step[] = [...Array.from({ length: 6 }, () => status(503)), json({})];
    const { client, sleeps } = harness(steps, { maxRetries: 6, maxDelayMs: 2000, random: () => 1 });
    await client.getJson("device");
    expect(sleeps).toEqual([500, 1000, 2000, 2000, 2000, 2000]);
  });

  it("jitter keeps every delay between zero and the ceiling", async () => {
    for (const r of [0, 0.01, 0.99]) {
      const { client, sleeps } = harness([status(503), status(503), json({})], { random: () => r });
      await client.getJson("device");
      expect(sleeps[0]).toBeGreaterThanOrEqual(0);
      expect(sleeps[0]).toBeLessThan(500);
      expect(sleeps[1]).toBeLessThan(1000);
    }
  });

  it("gives up after the retry budget with a retryable VendorError", async () => {
    const { client, calls } = harness(Array.from({ length: 5 }, () => status(503)));
    const error = await client.getJson("device").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VendorError);
    expect(error).toMatchObject({ status: 503, retryable: true });
    expect(calls).toHaveLength(5); // 1 try + 4 retries
  });

  it("retries network failures and timeouts", async () => {
    const timeout = Object.assign(new Error("aborted"), { name: "TimeoutError" });
    const { client, calls } = harness([new TypeError("fetch failed"), timeout, json({ ok: 1 })]);
    await expect(client.getJson("device")).resolves.toEqual({ ok: 1 });
    expect(calls).toHaveLength(3);
  });

  it("reports an exhausted network failure without leaking the underlying text", async () => {
    const cause = new TypeError("connect ECONNREFUSED 10.1.2.3:443 Basic c2VjcmV0");
    const { client } = harness(Array.from({ length: 5 }, () => cause));
    const error = (await client.getJson("device").catch((e: unknown) => e)) as NetworkError;
    expect(error).toBeInstanceOf(NetworkError);
    expect(error.timedOut).toBe(false);
    expect(error.message).toBe("The vendor API could not be reached.");
    expect(error.cause).toBe(cause);
  });

  it.each([400, 404, 409, 422])("does not retry a %s", async (code) => {
    const { client, calls, sleeps } = harness([status(code)]);
    const error = await client.getJson("device").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VendorError);
    expect(error).toMatchObject({ status: code, retryable: false });
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it.each([401, 403])("maps %s to AuthError without retrying", async (code) => {
    const { client, calls } = harness([status(code)]);
    const error = await client.getJson("device").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthError);
    expect(error).toMatchObject({ status: code, retryable: false });
    expect(calls).toHaveLength(1);
  });

  it("never puts the response body or the URL in an error message", async () => {
    for (const code of [400, 401, 500]) {
      const { client } = harness(Array.from({ length: 5 }, () => status(code)));
      const error = (await client
        .getJson("device", { token: "abc" })
        .catch((e: unknown) => e)) as Error;
      expect(error.message).not.toContain("error body");
      expect(error.message).not.toContain("abc");
    }
  });
});

describe("http client: rate limiting (HTTP 429)", () => {
  it("waits for Retry-After given in seconds", async () => {
    const { client, sleeps } = harness([status(429, { "retry-after": "7" }), json({ ok: 1 })]);
    await expect(client.getJson("device")).resolves.toEqual({ ok: 1 });
    expect(sleeps).toEqual([7000]);
  });

  it("waits for Retry-After given as an HTTP date", async () => {
    const { client, sleeps } = harness([
      status(429, { "retry-after": "Thu, 12 Nov 2026 12:00:20 GMT" }),
      json({}),
    ]);
    await client.getJson("device");
    expect(sleeps).toEqual([20_000]);
  });

  it("falls back to backoff when Retry-After is missing or unreadable", async () => {
    const { client, sleeps } = harness([
      status(429),
      status(429, { "retry-after": "soon" }),
      json({}),
    ]);
    await client.getJson("device");
    expect(sleeps).toEqual([250, 500]);
  });

  it("stops and reports the wait when the vendor asks for longer than we will block", async () => {
    const { client, calls, sleeps } = harness([status(429, { "retry-after": "900" })]);
    const error = await client.getJson("device").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error).toMatchObject({ retryAfterMs: 900_000, retryable: true });
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("gives up with RateLimitError when the limit never lifts", async () => {
    const { client, calls } = harness(
      Array.from({ length: 5 }, () => status(429, { "retry-after": "1" })),
    );
    await expect(client.getJson("device")).rejects.toBeInstanceOf(RateLimitError);
    expect(calls).toHaveLength(5);
  });

  it("honours Retry-After on a 503 as well", async () => {
    const { client, sleeps } = harness([status(503, { "retry-after": "3" }), json({})]);
    await client.getJson("device");
    expect(sleeps).toEqual([3000]);
  });
});

describe("http client: responses and concurrency", () => {
  it("rejects a 2xx whose body is not JSON", async () => {
    const { client } = harness([new Response("<html>maintenance</html>", { status: 200 })]);
    await expect(client.getJson("device")).rejects.toBeInstanceOf(InvalidResponseError);
  });

  it("never has more requests in flight than the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return json({});
    };
    const { client } = harness(
      Array.from({ length: 12 }, () => slow),
      { maxConcurrency: 3 },
    );
    await Promise.all(Array.from({ length: 12 }, (_, i) => client.getJson(`device/${i}`)));
    expect(peak).toBe(3);
  });

  it("releases its slot when a request fails", async () => {
    const { client } = harness([status(404), json({ ok: 1 })], { maxConcurrency: 1 });
    await expect(client.getJson("a")).rejects.toBeInstanceOf(VendorError);
    await expect(client.getJson("b")).resolves.toEqual({ ok: 1 });
  });

  it("logs the path and status but never headers, credentials or query values", async () => {
    const lines: string[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const logger = createLogger({ name: "http-test", level: "debug", destination });
    const { client } = harness([status(503), status(429, { "retry-after": "1" }), json({})], {
      logger,
      headers: () => ({ authorization: "Basic Zml4dHVyZS1jcmVkZW50aWFs" }),
    });
    await client.getJson("bcdr/device", { serial: "fixture-serial-value" });

    const output = lines.join("");
    expect(output).toContain("/v1/bcdr/device");
    expect(output).toContain("503");
    expect(output).not.toContain("Zml4dHVyZS1jcmVkZW50aWFs");
    expect(output).not.toContain("authorization");
    expect(output).not.toContain("fixture-serial-value");
  });
});

describe("collectPages", () => {
  const pages = (total: number, perPage: number) => (page: number) =>
    Promise.resolve({
      items: Array.from({ length: perPage }, (_, i) => (page - 1) * perPage + i),
      totalPages: total,
    });

  it("walks every page the vendor reports", async () => {
    const seen: number[] = [];
    const items = await collectPages((page) => {
      seen.push(page);
      return pages(3, 2)(page);
    });
    expect(seen).toEqual([1, 2, 3]);
    expect(items).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("stops at the first empty page when no total is reported", async () => {
    const data = [[1, 2], [3], []];
    const seen: number[] = [];
    const items = await collectPages(async (page) => {
      seen.push(page);
      return { items: data[page - 1] ?? [], totalPages: null };
    });
    expect(items).toEqual([1, 2, 3]);
    expect(seen).toEqual([1, 2, 3]);
  });

  it("handles a single page and an empty result", async () => {
    expect(await collectPages(pages(1, 3))).toEqual([0, 1, 2]);
    expect(await collectPages(async () => ({ items: [], totalPages: 0 }))).toEqual([]);
  });

  it("supports zero-based page numbering", async () => {
    const seen: number[] = [];
    await collectPages(
      async (page) => {
        seen.push(page);
        return { items: [page], totalPages: 2 };
      },
      { firstPage: 0 },
    );
    expect(seen).toEqual([0, 1]);
  });

  it("stops a vendor that never ends pagination", async () => {
    await expect(
      collectPages(async () => ({ items: [1], totalPages: null }), { maxPages: 5 }),
    ).rejects.toBeInstanceOf(InvalidResponseError);
  });

  it("propagates a failure part-way through", async () => {
    await expect(
      collectPages(async (page) => {
        if (page === 2) throw new VendorError(500);
        return { items: [page], totalPages: 3 };
      }),
    ).rejects.toBeInstanceOf(VendorError);
  });
});
