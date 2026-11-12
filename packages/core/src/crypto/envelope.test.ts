import { randomBytes, randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  DecryptionError,
  decryptJson,
  encryptJson,
  type EncryptedEnvelope,
  type EncryptionContext,
} from "./envelope";
import { createKeyProviderFromEnv, LocalKeyProvider, type KeyProvider } from "./key-provider";
import { Secret } from "./secret";

const newKey = () => randomBytes(32).toString("base64");
const provider = new LocalKeyProvider(newKey());

const tenantA = randomUUID();
const tenantB = randomUUID();
const integration = randomUUID();

const context: EncryptionContext = {
  tenantId: tenantA,
  recordId: integration,
  purpose: "integration-credentials",
};

// Obviously fake values: fixtures must never look like real credentials.
const credentials = { publicKey: "fixture-public", secretKey: "fixture-secret-value" };

/** Flips one bit in a base64 field. */
function tamper(envelope: EncryptedEnvelope, field: "ciphertext" | "iv" | "tag" | "wrappedKey") {
  const bytes = Buffer.from(envelope[field], "base64");
  bytes[0] = bytes[0]! ^ 0x01;
  return { ...envelope, [field]: bytes.toString("base64") };
}

describe("envelope encryption: round trip", () => {
  it("decrypts what it encrypted", async () => {
    const envelope = await encryptJson(credentials, context, provider);
    const secret = await decryptJson<typeof credentials>(envelope, context, provider);
    expect(secret.expose()).toEqual(credentials);
  });

  it("round-trips nested values and non-ASCII text", async () => {
    const value = { a: [1, 2, { b: null }], note: "pässwörd ✓ 日本語", n: 1.5, t: true };
    const envelope = await encryptJson(value, context, provider);
    expect((await decryptJson(envelope, context, provider)).expose()).toEqual(value);
  });

  it("stores nothing readable", async () => {
    const envelope = await encryptJson(credentials, context, provider);
    const stored = JSON.stringify(envelope);
    expect(stored).not.toContain("fixture-secret-value");
    expect(stored).not.toContain("fixture-public");
    expect(stored).not.toContain("secretKey");
    expect(stored).not.toContain(Buffer.from("fixture-secret-value").toString("base64"));
  });

  it("produces the documented envelope shape", async () => {
    const envelope = await encryptJson(credentials, context, provider);
    expect(Object.keys(envelope).sort()).toEqual(
      ["alg", "ciphertext", "iv", "keyId", "tag", "v", "wrappedKey"].sort(),
    );
    expect(envelope).toMatchObject({ v: 1, alg: "AES-256-GCM", keyId: provider.keyId });
    expect(Buffer.from(envelope.iv, "base64")).toHaveLength(12);
    expect(Buffer.from(envelope.tag, "base64")).toHaveLength(16);
  });

  it("uses a fresh data key and nonce every time", async () => {
    const first = await encryptJson(credentials, context, provider);
    const second = await encryptJson(credentials, context, provider);
    expect(second.ciphertext).not.toBe(first.ciphertext);
    expect(second.iv).not.toBe(first.iv);
    expect(second.wrappedKey).not.toBe(first.wrappedKey);
  });

  it("survives being stored as JSON and read back", async () => {
    const envelope = await encryptJson(credentials, context, provider);
    const fromDatabase: unknown = JSON.parse(JSON.stringify(envelope));
    expect((await decryptJson(fromDatabase, context, provider)).expose()).toEqual(credentials);
  });
});

describe("envelope encryption: binding to tenant and record", () => {
  it("a ciphertext moved to another tenant does not decrypt", async () => {
    const envelope = await encryptJson(credentials, context, provider);
    await expect(
      decryptJson(envelope, { ...context, tenantId: tenantB }, provider),
    ).rejects.toBeInstanceOf(DecryptionError);
  });

  it("a ciphertext moved to another integration in the same tenant does not decrypt", async () => {
    const envelope = await encryptJson(credentials, context, provider);
    await expect(
      decryptJson(envelope, { ...context, recordId: randomUUID() }, provider),
    ).rejects.toBeInstanceOf(DecryptionError);
  });

  it("the wrapped data key is bound to the context too, not only the ciphertext", async () => {
    const envelope = await encryptJson(credentials, context, provider);
    const aadA = Buffer.from(`v1|integration-credentials|${tenantA}|${integration}`);
    const aadB = Buffer.from(`v1|integration-credentials|${tenantB}|${integration}`);
    const wrapped = Buffer.from(envelope.wrappedKey, "base64");
    await expect(provider.unwrapKey(wrapped, envelope.keyId, aadA)).resolves.toHaveLength(32);
    await expect(provider.unwrapKey(wrapped, envelope.keyId, aadB)).rejects.toThrow();
  });

  it("rejects a context that could collide with another once joined", async () => {
    const sneaky = { ...context, tenantId: `${tenantA}|${integration}` };
    await expect(encryptJson(credentials, sneaky, provider)).rejects.toThrow();
    await expect(
      encryptJson(credentials, { ...context, recordId: "" }, provider),
    ).rejects.toThrow();
  });
});

describe("envelope encryption: tampering and wrong keys", () => {
  it.each(["ciphertext", "iv", "tag", "wrappedKey"] as const)(
    "a single flipped bit in %s is detected",
    async (field) => {
      const envelope = await encryptJson(credentials, context, provider);
      await expect(decryptJson(tamper(envelope, field), context, provider)).rejects.toBeInstanceOf(
        DecryptionError,
      );
    },
  );

  it("does not decrypt with a different key-encryption key", async () => {
    const envelope = await encryptJson(credentials, context, provider);
    const other = new LocalKeyProvider(newKey());
    await expect(decryptJson(envelope, context, other)).rejects.toBeInstanceOf(DecryptionError);
    // Even if the key id is forged to match.
    await expect(
      decryptJson({ ...envelope, keyId: other.keyId }, context, other),
    ).rejects.toBeInstanceOf(DecryptionError);
  });

  it("cannot be spliced: one envelope's data key with another's ciphertext", async () => {
    const one = await encryptJson(credentials, context, provider);
    const two = await encryptJson({ other: "value" }, context, provider);
    await expect(
      decryptJson({ ...one, wrappedKey: two.wrappedKey }, context, provider),
    ).rejects.toBeInstanceOf(DecryptionError);
  });

  it.each([
    ["null", null],
    ["a string", "not an envelope"],
    ["an empty object", {}],
    ["an unknown version", { v: 2 }],
    ["an extra field", "extra"],
    ["a missing field", "missing"],
    ["non-base64 data", "garbage"],
  ])("rejects a malformed envelope: %s", async (_label, bad) => {
    const good = await encryptJson(credentials, context, provider);
    let candidate: unknown = bad;
    if (bad === "extra") candidate = { ...good, plaintext: "x" };
    if (bad === "missing") candidate = { ...good, tag: undefined };
    if (bad === "garbage") candidate = { ...good, ciphertext: "***not base64***" };
    if (typeof bad === "object" && bad !== null && "v" in bad) candidate = { ...good, v: 2 };
    await expect(decryptJson(candidate, context, provider)).rejects.toBeInstanceOf(DecryptionError);
  });

  it("gives the same error whatever went wrong, with no detail to probe", async () => {
    const envelope = await encryptJson(credentials, context, provider);
    const failures = await Promise.all([
      decryptJson(tamper(envelope, "tag"), context, provider).catch((e: unknown) => e),
      decryptJson(envelope, { ...context, tenantId: tenantB }, provider).catch((e: unknown) => e),
      decryptJson({}, context, provider).catch((e: unknown) => e),
    ]);
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(DecryptionError);
      expect((failure as Error).message).toBe("The value could not be decrypted.");
      expect((failure as Error).cause).toBeUndefined();
    }
  });

  it("works with any key provider that honours the interface", async () => {
    // Stands in for a KMS: the key never leaves the provider.
    const inner = new LocalKeyProvider(newKey());
    const calls: string[] = [];
    const kmsLike: KeyProvider = {
      async wrapKey(dataKey, aad) {
        calls.push("wrap");
        return { ...(await inner.wrapKey(dataKey, aad)), keyId: "kms:alias/test" };
      },
      async unwrapKey(wrapped, keyId, aad) {
        calls.push(`unwrap:${keyId}`);
        return inner.unwrapKey(wrapped, inner.keyId, aad);
      },
    };
    const envelope = await encryptJson(credentials, context, kmsLike);
    expect(envelope.keyId).toBe("kms:alias/test");
    expect((await decryptJson(envelope, context, kmsLike)).expose()).toEqual(credentials);
    expect(calls).toEqual(["wrap", "unwrap:kms:alias/test"]);
  });
});

describe("LocalKeyProvider", () => {
  it("requires exactly 32 bytes of key", () => {
    expect(() => new LocalKeyProvider("")).toThrow(/32 bytes/);
    expect(() => new LocalKeyProvider(randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
    expect(() => new LocalKeyProvider(randomBytes(64).toString("base64"))).toThrow(/32 bytes/);
    expect(() => new LocalKeyProvider(newKey())).not.toThrow();
  });

  it("derives a stable key id that does not reveal the key", () => {
    const key = newKey();
    const one = new LocalKeyProvider(key);
    const two = new LocalKeyProvider(key);
    expect(one.keyId).toBe(two.keyId);
    expect(one.keyId).toMatch(/^local:[0-9a-f]{16}$/);
    expect(one.keyId).not.toContain(key.slice(0, 8));
    expect(new LocalKeyProvider(newKey()).keyId).not.toBe(one.keyId);
  });

  it("does not expose the key when printed or serialized", () => {
    const key = newKey();
    const local = new LocalKeyProvider(key);
    const raw = Buffer.from(key, "base64");
    for (const printed of [inspect(local, { depth: 5 }), JSON.stringify(local), String(local)]) {
      expect(printed).not.toContain(key);
      expect(printed).not.toContain(raw.toString("hex"));
    }
  });
});

describe("createKeyProviderFromEnv", () => {
  it("builds the local provider in development", () => {
    const built = createKeyProviderFromEnv({
      NODE_ENV: "development",
      VALTREXIA_KEY_PROVIDER: "local",
      VALTREXIA_LOCAL_KEK: newKey(),
    });
    expect(built).toBeInstanceOf(LocalKeyProvider);
  });

  it("defaults to local when no provider is named", () => {
    expect(createKeyProviderFromEnv({ VALTREXIA_LOCAL_KEK: newKey() })).toBeInstanceOf(
      LocalKeyProvider,
    );
  });

  it("refuses the local provider in production, even with a key present", () => {
    expect(() =>
      createKeyProviderFromEnv({
        NODE_ENV: "production",
        VALTREXIA_KEY_PROVIDER: "local",
        VALTREXIA_LOCAL_KEK: newKey(),
      }),
    ).toThrow(/not allowed in production/);
    expect(() =>
      createKeyProviderFromEnv({ NODE_ENV: "production", VALTREXIA_LOCAL_KEK: newKey() }),
    ).toThrow(/not allowed in production/);
  });

  it("explains how to create a key when none is set", () => {
    expect(() => createKeyProviderFromEnv({ VALTREXIA_KEY_PROVIDER: "local" })).toThrow(
      /openssl rand -base64 32/,
    );
  });

  it("rejects an unknown provider and says the KMS one is not built yet", () => {
    expect(() => createKeyProviderFromEnv({ VALTREXIA_KEY_PROVIDER: "vault" })).toThrow(/Unknown/);
    expect(() => createKeyProviderFromEnv({ VALTREXIA_KEY_PROVIDER: "kms" })).toThrow(
      /not implemented yet/,
    );
  });

  it("never echoes the configured key in an error", () => {
    const short = randomBytes(8).toString("base64");
    try {
      createKeyProviderFromEnv({ VALTREXIA_LOCAL_KEK: short });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain(short);
    }
  });
});

describe("Secret", () => {
  const secret = new Secret({ secretKey: "fixture-secret-value" });

  it("hands the value back only through expose()", () => {
    expect(secret.expose()).toEqual({ secretKey: "fixture-secret-value" });
  });

  it("prints as [redacted] everywhere else", () => {
    const printed = [
      String(secret),
      `${secret}`,
      JSON.stringify(secret),
      JSON.stringify({ nested: { secret } }),
      inspect(secret),
      inspect({ nested: [secret] }, { depth: 10 }),
    ];
    for (const text of printed) {
      expect(text).toContain("[redacted]");
      expect(text).not.toContain("fixture-secret-value");
    }
  });

  it("has no enumerable properties to spread or iterate", () => {
    expect(Object.keys(secret)).toEqual([]);
    expect({ ...secret }).toEqual({});
  });
});
