import { Writable } from "node:stream";
import { inspect } from "node:util";
import { createLogger, Secret } from "@valtrexia/core/server";
import { describe, expect, it } from "vitest";
import {
  AuthError,
  InvalidCredentialsShapeError,
  NetworkError,
  RateLimitError,
  VendorError,
} from "../errors";
import { createConnector } from "../registry";
import { DattoConnector } from "./connector";
import { dattoCredentialHint, dattoCredentialsSchema } from "./credentials";

// Obviously fake. Fixtures must never look like real keys.
const credentials = { publicKey: "fixture-public-9f3a", secretKey: "fixture-secret-do-not-use" };
const expectedHeader = `Basic ${Buffer.from("fixture-public-9f3a:fixture-secret-do-not-use").toString("base64")}`;

function fakeFetch(responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { impl, calls };
}

const ok = () =>
  new Response(JSON.stringify({ pagination: { page: 1, perPage: 1, totalPages: 1 }, items: [] }), {
    status: 200,
  });
const noSleep = { sleep: async () => undefined, random: () => 0 };

describe("datto credentials", () => {
  it("accepts a public and secret key and trims stray whitespace", () => {
    expect(
      dattoCredentialsSchema.parse({ publicKey: "  abc123  ", secretKey: "s3cr3t-key\n" }),
    ).toEqual({ publicKey: "abc123", secretKey: "s3cr3t-key" });
  });

  it.each([
    ["a missing secret key", { publicKey: "abc123" }],
    ["an empty key", { publicKey: "", secretKey: "abcd" }],
    ["a key with a space inside", { publicKey: "abc 123", secretKey: "abcd" }],
    ["a key with a control character", { publicKey: "abc\u0000123", secretKey: "abcd" }],
    ["a key that is absurdly long", { publicKey: "a".repeat(201), secretKey: "abcd" }],
    [
      "an unexpected extra field",
      { publicKey: "abcd", secretKey: "abcd", baseUrl: "https://evil.test" },
    ],
    ["a non-string key", { publicKey: 1234, secretKey: "abcd" }],
  ])("rejects %s", (_label, input) => {
    expect(dattoCredentialsSchema.safeParse(input).success).toBe(false);
  });

  it("derives the hint from the public key only", () => {
    expect(dattoCredentialHint("fixture-public-9f3a")).toBe("9f3a");
    expect(dattoCredentialHint("  ab  ")).toBe("ab");
  });
});

describe("datto connector: testConnection", () => {
  it("asks Datto for one device, using Basic auth built from the key pair", async () => {
    const { impl, calls } = fakeFetch([ok()]);
    await new DattoConnector(credentials, { fetch: impl }).testConnection();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.datto.com/v1/bcdr/device?_page=1&_perPage=1");
    expect(calls[0]!.init?.method).toBe("GET");
    expect(calls[0]!.init?.headers).toMatchObject({ authorization: expectedHeader });
  });

  it.each([401, 403])(
    "reports rejected keys (%s) as AuthError, without retrying",
    async (status) => {
      const { impl, calls } = fakeFetch([new Response("denied", { status })]);
      await expect(
        new DattoConnector(credentials, { fetch: impl }).testConnection(),
      ).rejects.toBeInstanceOf(AuthError);
      expect(calls).toHaveLength(1);
    },
  );

  it("retries a transient failure and then succeeds", async () => {
    const { impl, calls } = fakeFetch([new Response("", { status: 503 }), ok()]);
    await new DattoConnector(credentials, { fetch: impl, ...noSleep }).testConnection();
    expect(calls).toHaveLength(2);
  });

  it("reports an outage, a rate limit and an unexpected status as distinct errors", async () => {
    const run = (responses: (Response | Error)[]) =>
      new DattoConnector(credentials, {
        fetch: fakeFetch(responses).impl,
        maxRetries: 0,
        ...noSleep,
      })
        .testConnection()
        .catch((e: unknown) => e);

    expect(await run([new TypeError("fetch failed")])).toBeInstanceOf(NetworkError);
    expect(
      await run([new Response("", { status: 429, headers: { "retry-after": "600" } })]),
    ).toBeInstanceOf(RateLimitError);
    expect(await run([new Response("", { status: 404 })])).toBeInstanceOf(VendorError);
  });

  it("uses the configured base URL when one is given, and insists on https", async () => {
    const { impl, calls } = fakeFetch([ok()]);
    await new DattoConnector(credentials, {
      fetch: impl,
      baseUrl: "https://datto-sandbox.example.test/v1",
    }).testConnection();
    expect(calls[0]!.url).toMatch(/^https:\/\/datto-sandbox\.example\.test\/v1\/bcdr\/device/);

    expect(() => new DattoConnector(credentials, { baseUrl: "http://api.datto.com/v1" })).toThrow(
      /https/,
    );
  });

  it("only ever issues GET requests", async () => {
    const { impl, calls } = fakeFetch([ok(), new Response("", { status: 401 })]);
    const connector = new DattoConnector(credentials, { fetch: impl });
    await connector.testConnection();
    await connector.testConnection().catch(() => undefined);
    expect(calls.map((c) => c.init?.method)).toEqual(["GET", "GET"]);
  });
});

describe("datto connector: keeping the keys private", () => {
  it("does not expose the keys when printed or serialized", () => {
    const connector = new DattoConnector(credentials);
    for (const text of [
      inspect(connector, { depth: 6 }),
      JSON.stringify(connector),
      String(connector),
    ]) {
      expect(text).not.toContain("fixture-secret-do-not-use");
      expect(text).not.toContain("fixture-public-9f3a");
      expect(text).not.toContain(expectedHeader);
    }
  });

  it("logs nothing derived from the keys, on success or failure", async () => {
    const lines: string[] = [];
    const logger = createLogger({
      name: "datto-test",
      level: "debug",
      destination: new Writable({
        write(chunk: Buffer, _encoding, done) {
          lines.push(chunk.toString());
          done();
        },
      }),
    });
    const { impl } = fakeFetch([
      new Response("", { status: 503 }),
      ok(),
      new Response("", { status: 401 }),
    ]);
    const connector = new DattoConnector(credentials, { fetch: impl, logger, ...noSleep });
    await connector.testConnection();
    await connector.testConnection().catch(() => undefined);

    const output = lines.join("");
    expect(output).toContain("/v1/bcdr/device");
    expect(output).not.toContain("fixture-secret-do-not-use");
    expect(output).not.toContain("fixture-public-9f3a");
    expect(output).not.toContain(expectedHeader.slice(6));
  });

  it("puts nothing from the keys or the response in an error", async () => {
    const { impl } = fakeFetch([new Response(`bad key ${credentials.secretKey}`, { status: 401 })]);
    const error = (await new DattoConnector(credentials, { fetch: impl })
      .testConnection()
      .catch((e: unknown) => e)) as Error;
    expect(inspect(error, { depth: 6 })).not.toContain("fixture-secret-do-not-use");
    expect(error.message).toBe(
      "The vendor rejected these credentials. Check the keys and their permissions.",
    );
  });
});

describe("datto connector: through the registry", () => {
  it("is built from saved credentials", () => {
    const connector = createConnector("datto_bcdr", new Secret(credentials), { allowMock: false });
    expect(connector).toBeInstanceOf(DattoConnector);
  });

  it("rejects saved credentials of the wrong shape without echoing them", () => {
    try {
      createConnector("datto_bcdr", new Secret({ publicKey: "fixture-public-9f3a" }), {
        allowMock: false,
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidCredentialsShapeError);
      expect(String(error)).not.toContain("fixture-public-9f3a");
    }
  });

  it("passes the configured base URL through", async () => {
    const { impl, calls } = fakeFetch([ok()]);
    await createConnector("datto_bcdr", new Secret(credentials), {
      allowMock: false,
      fetch: impl,
      dattoBaseUrl: "https://datto-sandbox.example.test/v1",
    }).testConnection();
    expect(calls[0]!.url).toContain("datto-sandbox.example.test");
  });
});
