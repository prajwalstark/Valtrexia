import { describe, expect, it } from "vitest";
import { createLogger } from "../logging/logger";
import { createEmailSenderFromEnv, EmailSendError, type EmailMessage } from "./email-sender";
import {
  failureFor,
  idempotencyKey,
  parseSender,
  RESEND_API_URL,
  ResendEmailSender,
} from "./resend";
import { FAKE_RESEND_KEY, fakeResend } from "./resend-fixtures";
import { Writable } from "node:stream";

const message: EmailMessage = {
  to: ["ops@msp.example", "lead@msp.example"],
  subject: "1 new backup problem at Acme Dental",
  text: "SRV01 failed.",
  html: "<p>SRV01 failed.</p>",
  idempotencyKey: "4f9c1b2e-0000-4000-8000-000000000001",
};

function sender(fake = fakeResend(), extra: { replyTo?: string; logLines?: string[] } = {}) {
  const lines = extra.logLines;
  const logger = createLogger({
    name: "resend-test",
    level: "debug",
    destination: new Writable({
      write(chunk: Buffer, _e, done) {
        lines?.push(chunk.toString());
        done();
      },
    }),
  });
  return new ResendEmailSender({
    apiKey: FAKE_RESEND_KEY,
    from: "Northwind Alerts <alerts@msp.example>",
    ...(extra.replyTo ? { replyTo: extra.replyTo } : {}),
    fetch: fake.fetch,
    logger,
  });
}

describe("Resend sender", () => {
  it("sends one message as Resend's API describes it", async () => {
    const fake = fakeResend();
    await sender(fake, { replyTo: "help@msp.example" }).send(message);
    expect(fake.delivered).toEqual([
      {
        from: "Northwind Alerts <alerts@msp.example>",
        to: ["ops@msp.example", "lead@msp.example"],
        subject: message.subject,
        html: message.html,
        text: message.text,
        reply_to: "help@msp.example",
      },
    ]);
    const [request] = fake.requests;
    expect(request!.method).toBe("POST");
    expect(request!.url).toBe(RESEND_API_URL);
    expect(request!.headers.get("authorization")).toBe(`Bearer ${FAKE_RESEND_KEY}`);
    expect(request!.headers.get("user-agent")).toMatch(/-Email\/1$/);
    expect(request!.headers.get("idempotency-key")).toMatch(
      new RegExp(`^${message.idempotencyKey}:[0-9a-f]{32}$`),
    );
  });

  it("sends a retried message once", async () => {
    const fake = fakeResend();
    const s = sender(fake);
    await s.send(message);
    await s.send(message);
    expect(fake.requests).toHaveLength(2);
    expect(fake.delivered).toHaveLength(1);
  });

  it("sends a retried message whose wording changed, rather than having it refused", async () => {
    const fake = fakeResend();
    const s = sender(fake);
    await s.send(message);
    await s.send({ ...message, text: "SRV01 failed. (channel renamed)" });
    expect(fake.delivered).toHaveLength(2);
    expect(idempotencyKey("a", "x")).not.toBe(idempotencyKey("a", "y"));
    expect(idempotencyKey("a".repeat(300), "x").length).toBeLessThanOrEqual(256);
  });

  it.each([
    [429, "rate_limit_exceeded", true, /limiting how fast/],
    [429, "daily_quota_exceeded", true, /quota/],
    [429, "monthly_quota_exceeded", true, /quota/],
    [409, "concurrent_idempotent_requests", true, /had a problem/],
    [500, "application_error", true, /had a problem/],
    [503, "service_unavailable", true, /had a problem/],
    [503, "dns_lookup_failed", true, /had a problem/],
    [401, "validation_error", true, /operator needs to fix/],
    [401, "missing_api_key", true, /operator needs to fix/],
    [403, "validation_error", true, /operator needs to fix/],
    [403, "restricted_api_key", true, /operator needs to fix/],
    [403, "suspended_api_key", true, /operator needs to fix/],
    [400, "validation_error", false, /refused the message as invalid/],
    [400, "invalid_idempotency_key", false, /refused the message as invalid/],
    [409, "invalid_idempotent_request", false, /refused the message as invalid/],
    [422, "missing_required_field", false, /refused the message as invalid/],
    [422, "validation_error", false, /refused the message as invalid/],
  ])("treats %i %s as retryable=%s", async (status, name, retryable, words) => {
    const fake = fakeResend();
    fake.failNext({
      status,
      name,
      message: "You can only send testing emails to your own email address (owner@private.example)",
    });
    const error = await sender(fake)
      .send(message)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmailSendError);
    expect((error as EmailSendError).retryable).toBe(retryable);
    expect((error as Error).message).toMatch(words);
    // Resend's own message can quote addresses; it is never passed on.
    expect((error as Error).message).not.toContain("private.example");
  });

  it("treats an unreadable error, or any 5xx, by its status", () => {
    expect(failureFor(502, null).retryable).toBe(true);
    expect(failureFor(418, null).retryable).toBe(false);
  });

  it("retries after a network failure or a timeout, and follows no redirect", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const s = new ResendEmailSender({ apiKey: "re_x", from: "a@b.example", fetch: down });
    await expect(s.send(message)).rejects.toMatchObject({ retryable: true });

    let init: RequestInit | undefined;
    const spy = (async (_: unknown, i?: RequestInit) => {
      init = i;
      return Response.json({ id: "x" });
    }) as typeof fetch;
    await new ResendEmailSender({ apiKey: "re_x", from: "a@b.example", fetch: spy }).send(message);
    expect(init?.redirect).toBe("error");
  });

  it("refuses a message with no recipients, or more than Resend takes", async () => {
    const fake = fakeResend();
    await expect(sender(fake).send({ ...message, to: [] })).rejects.toMatchObject({
      retryable: false,
    });
    const many = Array.from({ length: 51 }, (_, i) => `u${i}@msp.example`);
    await expect(sender(fake).send({ ...message, to: many })).rejects.toMatchObject({
      retryable: false,
    });
    expect(fake.requests).toHaveLength(0);
  });

  it("logs the status and error type only: no key, address or content", async () => {
    const lines: string[] = [];
    const fake = fakeResend();
    fake.failNext({
      status: 403,
      name: "validation_error",
      message: "domain msp.example is not verified",
    });
    await sender(fake, { logLines: lines })
      .send(message)
      .catch(() => undefined);
    const log = lines.join("\n");
    expect(log).toContain('"type":"validation_error"');
    for (const secret of [FAKE_RESEND_KEY, "ops@msp.example", "SRV01", "not verified"]) {
      expect(log).not.toContain(secret);
    }
  });
});

describe("sender addresses", () => {
  it.each([
    ["alerts@msp.example", "alerts@msp.example"],
    ["  Northwind <alerts@msp.example> ", "Northwind <alerts@msp.example>"],
    ["Ops Team<ops@mail.msp.example>", "Ops Team <ops@mail.msp.example>"],
  ])("accepts %j", (input, output) => {
    expect(parseSender(input)).toBe(output);
  });

  it.each([
    "",
    "not an address",
    "alerts@localhost",
    "Bad <name> <a@b.example>",
    'Quote" <a@b.example>',
    "Evil\r\nBcc: x@y.example <a@b.example>",
    "a@b.example\nBcc: x@y.example",
    "<a@b.example>",
  ])("refuses %j", (input) => {
    expect(parseSender(input)).toBeNull();
  });
});

describe("configuring email", () => {
  const logger = createLogger({ name: "t", level: "silent" });
  const env = {
    EMAIL_PROVIDER: "resend",
    RESEND_API_KEY: "re_x",
    EMAIL_FROM: "alerts@msp.example",
  };

  it("builds the Resend sender, in production too", () => {
    expect(createEmailSenderFromEnv({ ...env, NODE_ENV: "production" }, logger)?.name).toBe(
      "resend",
    );
  });

  it("names what is missing or wrong, without repeating a key", () => {
    expect(() => createEmailSenderFromEnv({ ...env, RESEND_API_KEY: " " }, logger)).toThrow(
      /needs RESEND_API_KEY/,
    );
    expect(() => createEmailSenderFromEnv({ ...env, EMAIL_FROM: "" }, logger)).toThrow(
      /needs EMAIL_FROM/,
    );
    expect(() => createEmailSenderFromEnv({ ...env, EMAIL_FROM: "nope" }, logger)).toThrow(
      /EMAIL_FROM must be/,
    );
    expect(() => createEmailSenderFromEnv({ ...env, EMAIL_REPLY_TO: "nope" }, logger)).toThrow(
      /EMAIL_REPLY_TO must be/,
    );
    try {
      createEmailSenderFromEnv(
        { ...env, EMAIL_PROVIDER: "sendgrid", RESEND_API_KEY: "re_secret" },
        logger,
      );
      expect.unreachable();
    } catch (error) {
      expect(String(error)).toMatch(/unknown provider/);
      expect(String(error)).not.toContain("re_secret");
    }
  });
});
