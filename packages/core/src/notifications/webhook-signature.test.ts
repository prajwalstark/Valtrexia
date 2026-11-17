import { describe, expect, it } from "vitest";
import { generateWebhookSecret, signWebhook, verifyWebhook } from "./webhook-signature";

// The worked example published with the Standard Webhooks specification.
const EXAMPLE = {
  secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
  id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
  timestamp: new Date(1614265330 * 1000),
  body: '{"test": 2432232314}',
  signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
};

describe("signWebhook", () => {
  it("produces the signature the specification's own example expects", () => {
    expect(signWebhook(EXAMPLE, EXAMPLE.secret)).toEqual({
      "webhook-id": EXAMPLE.id,
      "webhook-timestamp": "1614265330",
      "webhook-signature": EXAMPLE.signature,
    });
  });

  it("signs the id, the timestamp and the body: changing any one changes the signature", () => {
    const base = signWebhook(EXAMPLE, EXAMPLE.secret)["webhook-signature"];
    const variants = [
      { ...EXAMPLE, id: "msg_other" },
      { ...EXAMPLE, timestamp: new Date(1614265331 * 1000) },
      { ...EXAMPLE, body: '{"test": 2432232315}' },
    ];
    for (const variant of variants) {
      expect(signWebhook(variant, EXAMPLE.secret)["webhook-signature"]).not.toBe(base);
    }
    expect(signWebhook(EXAMPLE, generateWebhookSecret())["webhook-signature"]).not.toBe(base);
  });

  it("refuses a secret that is not one of ours", () => {
    expect(() => signWebhook(EXAMPLE, "not-a-secret")).toThrow("Invalid webhook signing secret.");
    expect(() => signWebhook(EXAMPLE, "whsec_c2hvcnQ=")).toThrow("Invalid webhook signing secret.");
  });
});

describe("generateWebhookSecret", () => {
  it("makes a new 32-byte secret each time, in the standard form", () => {
    const secrets = Array.from({ length: 50 }, generateWebhookSecret);
    expect(new Set(secrets).size).toBe(50);
    for (const secret of secrets) {
      expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
      expect(Buffer.from(secret.slice(6), "base64")).toHaveLength(32);
    }
  });
});

describe("verifyWebhook", () => {
  const at = EXAMPLE.timestamp;
  const headers = signWebhook(EXAMPLE, EXAMPLE.secret);

  it("accepts a genuine request", () => {
    expect(verifyWebhook(headers, EXAMPLE.body, EXAMPLE.secret, { now: at })).toBe(true);
  });

  it("refuses a changed body, a changed id, or another secret", () => {
    expect(verifyWebhook(headers, EXAMPLE.body + " ", EXAMPLE.secret, { now: at })).toBe(false);
    expect(
      verifyWebhook({ ...headers, "webhook-id": "msg_x" }, EXAMPLE.body, EXAMPLE.secret, {
        now: at,
      }),
    ).toBe(false);
    expect(verifyWebhook(headers, EXAMPLE.body, generateWebhookSecret(), { now: at })).toBe(false);
  });

  it("refuses a request replayed outside the tolerance, in either direction", () => {
    const later = (seconds: number) => ({ now: new Date(at.getTime() + seconds * 1000) });
    expect(verifyWebhook(headers, EXAMPLE.body, EXAMPLE.secret, later(300))).toBe(true);
    expect(verifyWebhook(headers, EXAMPLE.body, EXAMPLE.secret, later(301))).toBe(false);
    expect(verifyWebhook(headers, EXAMPLE.body, EXAMPLE.secret, later(-301))).toBe(false);
  });

  it("refuses missing or malformed headers", () => {
    for (const missing of ["webhook-id", "webhook-timestamp", "webhook-signature"]) {
      const without = { ...headers, [missing]: undefined };
      expect(verifyWebhook(without, EXAMPLE.body, EXAMPLE.secret, { now: at })).toBe(false);
    }
    for (const signature of ["", "v1,", "v2," + EXAMPLE.signature.slice(3), "garbage"]) {
      const bad = { ...headers, "webhook-signature": signature };
      expect(verifyWebhook(bad, EXAMPLE.body, EXAMPLE.secret, { now: at })).toBe(false);
    }
    const badTime = { ...headers, "webhook-timestamp": "soon" };
    expect(verifyWebhook(badTime, EXAMPLE.body, EXAMPLE.secret, { now: at })).toBe(false);
  });

  it("accepts any one of several signatures, as during a secret rotation", () => {
    const rotated = { ...headers, "webhook-signature": `v1,AAAA ${EXAMPLE.signature}` };
    expect(verifyWebhook(rotated, EXAMPLE.body, EXAMPLE.secret, { now: at })).toBe(true);
  });
});
