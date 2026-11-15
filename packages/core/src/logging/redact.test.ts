import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { Secret } from "../crypto/secret";
import { createLogger } from "./logger";
import { isSensitiveKey, redact, REDACTED, scrubString } from "./redact";

describe("isSensitiveKey", () => {
  it.each([
    "password",
    "Password",
    "dbPassword",
    "secret",
    "secretKey",
    "secret_key",
    "Secret-Key",
    "clientSecret",
    "publicKey",
    "apiKey",
    "api_key",
    "x-api-key",
    "token",
    "accessToken",
    "refresh_token",
    "authorization",
    "Authorization",
    "credentials",
    "credentialsEnc",
    "cookie",
    "set-cookie",
    "rawPayload",
    "raw_payload",
    "ciphertext",
    "wrappedKey",
    "headers",
    "kek",
  ])("treats %s as sensitive", (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each([
    "id",
    "tenantId",
    "integrationId",
    "vendor",
    "status",
    "message",
    "name",
    "durationMs",
    "screenshotVerified",
    "keyId",
    "bypass",
    "attempt",
  ])("leaves %s alone", (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });
});

describe("scrubString", () => {
  it("removes HTTP auth credentials", () => {
    expect(scrubString("Authorization: Basic Zml4dHVyZTpmaXh0dXJl")).toBe(
      `Authorization: Basic ${REDACTED}`,
    );
    expect(scrubString("sent Bearer abc123.def456-ghi")).toBe(`sent Bearer ${REDACTED}`);
  });

  it("removes the user:password part of a URL", () => {
    expect(scrubString("connect postgresql://app:hunter2fixture@db.internal:5432/x failed")).toBe(
      `connect postgresql://${REDACTED}@db.internal:5432/x failed`,
    );
    expect(scrubString("GET https://pub:sec@api.example.test/v1")).toBe(
      `GET https://${REDACTED}@api.example.test/v1`,
    );
  });

  it("removes secrets passed as query parameters", () => {
    expect(scrubString("GET /v1/device?api_key=fixture123&page=2")).toBe(
      `GET /v1/device?api_key=${REDACTED}&page=2`,
    );
    expect(scrubString("token=abc secretKey=def password=ghi")).toBe(
      `token=${REDACTED} secretKey=${REDACTED} password=${REDACTED}`,
    );
  });

  it("leaves ordinary text and URLs untouched", () => {
    const plain = "GET https://api.example.test/v1/bcdr/device?_page=2 returned 429 after 3 tries";
    expect(scrubString(plain)).toBe(plain);
  });
});

describe("redact", () => {
  it("replaces sensitive properties at any depth and keeps everything else", () => {
    const input = {
      integrationId: "int_1",
      credentials: { publicKey: "fixture-public", secretKey: "fixture-secret" },
      request: { url: "/device", headers: { authorization: "Basic eA==" }, attempt: 2 },
      results: [{ status: "success", rawPayload: { huge: true } }],
    };
    expect(redact(input)).toEqual({
      integrationId: "int_1",
      credentials: REDACTED,
      request: { url: "/device", headers: REDACTED, attempt: 2 },
      results: [{ status: "success", rawPayload: REDACTED }],
    });
  });

  it("does not modify the object it was given", () => {
    const input = { secretKey: "fixture-secret", nested: { token: "fixture-token" } };
    redact(input);
    expect(input).toEqual({ secretKey: "fixture-secret", nested: { token: "fixture-token" } });
  });

  it("redacts Secret wrappers and binary data whatever they are called", () => {
    expect(
      redact({ value: new Secret("fixture-secret"), blob: Buffer.from("fixture-secret") }),
    ).toEqual({ value: REDACTED, blob: "[binary]" });
  });

  it("flattens errors, scrubbing their message, stack and cause", () => {
    const cause = new Error("upstream said Bearer abcdef123456");
    const error = Object.assign(
      new Error("GET https://pub:sec@api.example.test failed", { cause }),
      { code: "ECONNRESET", config: { headers: { authorization: "Basic eA==" } } },
    );
    const out = redact({ err: error }) as { err: Record<string, unknown> };
    expect(out.err.type).toBe("Error");
    expect(out.err.message).toBe(`GET https://${REDACTED}@api.example.test failed`);
    expect(out.err.code).toBe("ECONNRESET");
    expect(out.err.cause).toMatchObject({ message: `upstream said Bearer ${REDACTED}` });
    // Arbitrary properties hung on an error (such as an HTTP client's request config) are dropped.
    expect(out.err).not.toHaveProperty("config");
    expect(JSON.stringify(out)).not.toContain("pub:sec");
  });

  it("survives circular references and very deep structures", () => {
    const loop: Record<string, unknown> = { name: "loop" };
    loop.self = loop;
    expect(redact(loop)).toEqual({ name: "loop", self: "[circular]" });

    let deep: Record<string, unknown> = { secretKey: "fixture-secret" };
    for (let i = 0; i < 30; i += 1) deep = { child: deep };
    const text = JSON.stringify(redact(deep));
    expect(text).toContain("[truncated]");
    expect(text).not.toContain("fixture-secret");
  });

  it("passes primitives through and keeps dates", () => {
    const when = new Date("2026-11-12T00:00:00Z");
    expect(redact({ n: 1, b: false, z: null, u: undefined, when, big: 10n })).toEqual({
      n: 1,
      b: false,
      z: null,
      u: undefined,
      when,
      big: "10",
    });
  });
});

describe("createLogger", () => {
  function capture() {
    const lines: string[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const log = createLogger({ name: "test", level: "debug", destination });
    const records = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    return { log, lines, records };
  }

  it("writes structured JSON with the level as a word", () => {
    const { log, records } = capture();
    log.info({ integrationId: "int_1", assets: 12 }, "sync finished");
    expect(records()[0]).toMatchObject({
      level: "info",
      name: "test",
      msg: "sync finished",
      integrationId: "int_1",
      assets: 12,
    });
  });

  it("never writes credentials or vendor payloads, however they are passed", () => {
    const { log, lines } = capture();
    const credentials = { publicKey: "fixture-public-key", secretKey: "fixture-secret-key" };

    log.info({ credentials }, "as a property");
    log.info(
      { integration: { name: "Datto", credentialsEnc: { ciphertext: "fixture-cipher" } } },
      "nested",
    );
    log.info(
      { result: { status: "failed", rawPayload: { note: "fixture-payload-body" } } },
      "payload",
    );
    log.info({ headers: { authorization: "Basic fixture-header-value" } }, "headers");
    log.info({ value: new Secret(credentials) }, "wrapped");
    log.warn(
      "calling https://fixture-user:fixture-pass@api.example.test with Bearer fixture-bearer-token",
    );
    log.error({ err: new Error("401 for Basic Zml4dHVyZS1iYXNpYw==") }, "request failed");
    log.child({ secretKey: "fixture-child-binding" }).info("from a child logger");
    log
      .child({ integrationId: "int_1" })
      .child({ credentials: { secretKey: "fixture-grandchild-binding" } })
      .info("from a grandchild logger");

    const output = lines.join("");
    for (const leaked of [
      "fixture-public-key",
      "fixture-secret-key",
      "fixture-cipher",
      "fixture-payload-body",
      "fixture-header-value",
      "fixture-user",
      "fixture-pass",
      "fixture-bearer-token",
      "Zml4dHVyZS1iYXNpYw==",
      "fixture-child-binding",
      "fixture-grandchild-binding",
    ]) {
      expect(output, `log output must not contain ${leaked}`).not.toContain(leaked);
    }
    expect(lines).toHaveLength(9);
    expect(output).toContain(REDACTED);
  });

  it("keeps the useful parts of an error", () => {
    const { log, records } = capture();
    log.error(
      { err: Object.assign(new Error("vendor returned 429"), { code: "RATE_LIMITED" }) },
      "sync failed",
    );
    expect(records()[0]).toMatchObject({
      level: "error",
      msg: "sync failed",
      err: { type: "Error", message: "vendor returned 429", code: "RATE_LIMITED" },
    });
  });

  it("keeps ordinary child bindings", () => {
    const { log, records } = capture();
    log.child({ integrationId: "int_1", vendor: "datto_bcdr" }).info("sync started");
    expect(records()[0]).toMatchObject({
      integrationId: "int_1",
      vendor: "datto_bcdr",
      msg: "sync started",
    });
  });

  it("respects the configured level", () => {
    const lines: string[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const log = createLogger({ name: "quiet", level: "warn", destination });
    log.info("not written");
    log.warn("written");
    expect(lines).toHaveLength(1);
  });
});
