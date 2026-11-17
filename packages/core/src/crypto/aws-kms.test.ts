import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AwsKmsKeyProvider, type KmsSender } from "./aws-kms";
import { createKeyProviderFromEnv } from "./config";
import {
  DecryptionError,
  decryptJson,
  encryptJson,
  rewrapEnvelope,
  type EncryptionContext,
} from "./envelope";
import { FakeKms } from "./fake-kms";
import { KeyServiceUnavailableError, LocalKeyProvider, RotatingKeyProvider } from "./key-provider";

const credentials = { publicKey: "pk-0123", secretKey: "sk-must-stay-secret-4567" };
const context: EncryptionContext = {
  tenantId: randomUUID(),
  recordId: randomUUID(),
  purpose: "integration-credentials",
};
const ALIAS = "arn:aws:kms:eu-west-1:111122223333:alias/valtrexia";

function setup() {
  const kms = new FakeKms();
  const keyArn = kms.createKey("1111aaaa-0000-4000-8000-000000000001", "valtrexia");
  return { kms, keyArn, provider: new AwsKmsKeyProvider(ALIAS, kms) };
}

describe("AwsKmsKeyProvider", () => {
  it("round-trips a value, recording the key's ARN even when configured with an alias", async () => {
    const { kms, keyArn, provider } = setup();
    const envelope = await encryptJson(credentials, context, provider);
    expect(envelope.keyId).toBe(`aws-kms:${keyArn}`);
    expect(JSON.stringify(envelope)).not.toContain(credentials.secretKey);
    expect((await decryptJson(envelope, context, provider)).expose()).toEqual(credentials);
    expect(kms.calls.map((c) => [c.op, c.keyId])).toEqual([
      ["Encrypt", ALIAS],
      // Decrypt names the key, so KMS refuses a ciphertext made with any other.
      ["Decrypt", keyArn],
    ]);
  });

  it("passes the tenant, record and purpose to KMS as encryption context", async () => {
    const { kms, provider } = setup();
    await encryptJson(credentials, context, provider);
    expect(kms.calls[0]!.context).toEqual({
      valtrexia: `v1|integration-credentials|${context.tenantId}|${context.recordId}`,
    });
  });

  it("will not decrypt a value copied onto another tenant, record or purpose", async () => {
    const { provider } = setup();
    const envelope = await encryptJson(credentials, context, provider);
    for (const other of [
      { ...context, tenantId: randomUUID() },
      { ...context, recordId: randomUUID() },
      { ...context, purpose: "notification-channel" as const },
    ]) {
      await expect(decryptJson(envelope, other, provider)).rejects.toBeInstanceOf(DecryptionError);
    }
  });

  it("will not decrypt a wrapped key that was altered or relabelled", async () => {
    const { kms, provider } = setup();
    const envelope = await encryptJson(credentials, context, provider);
    const wrapped = Buffer.from(envelope.wrappedKey, "base64");
    wrapped[wrapped.length - 1]! ^= 1;
    await expect(
      decryptJson({ ...envelope, wrappedKey: wrapped.toString("base64") }, context, provider),
    ).rejects.toBeInstanceOf(DecryptionError);

    const other = kms.createKey("2222bbbb-0000-4000-8000-000000000002");
    await expect(
      decryptJson({ ...envelope, keyId: `aws-kms:${other}` }, context, provider),
    ).rejects.toBeInstanceOf(DecryptionError);
  });

  it.each([
    "ThrottlingException",
    "KMSInternalException",
    "DependencyTimeoutException",
    "KeyUnavailableException",
    "DisabledException",
    "AccessDeniedException",
    "NotFoundException",
    "TimeoutError",
  ])(
    "reports %s on decrypt as the key service being unavailable, not as bad data",
    async (name) => {
      const { kms, provider } = setup();
      const envelope = await encryptJson(credentials, context, provider);
      kms.failNext(name);
      const error = await decryptJson(envelope, context, provider).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(KeyServiceUnavailableError);
      expect(error).not.toBeInstanceOf(DecryptionError);
      expect(String(error)).not.toContain("arn:aws");
    },
  );

  it("reports a key service failure while encrypting, and saves nothing half-done", async () => {
    const { kms, provider } = setup();
    kms.failNext("ThrottlingException");
    await expect(encryptJson(credentials, context, provider)).rejects.toBeInstanceOf(
      KeyServiceUnavailableError,
    );
  });

  it("reports a disabled key as unavailable, and reads again once it is re-enabled", async () => {
    const { kms, keyArn, provider } = setup();
    const envelope = await encryptJson(credentials, context, provider);
    kms.setEnabled(keyArn, false);
    await expect(decryptJson(envelope, context, provider)).rejects.toBeInstanceOf(
      KeyServiceUnavailableError,
    );
    kms.setEnabled(keyArn, true);
    expect((await decryptJson(envelope, context, provider)).expose()).toEqual(credentials);
  });

  it("keeps reading old records after the alias is pointed at a new key", async () => {
    const { kms, keyArn, provider } = setup();
    const before = await encryptJson(credentials, context, provider);
    const newArn = kms.createKey("3333cccc-0000-4000-8000-000000000003");
    kms.pointAlias("valtrexia", newArn);
    const after = await encryptJson(credentials, context, provider);
    expect([before.keyId, after.keyId]).toEqual([`aws-kms:${keyArn}`, `aws-kms:${newArn}`]);
    for (const envelope of [before, after]) {
      expect((await decryptJson(envelope, context, provider)).expose()).toEqual(credentials);
    }
  });

  it("refuses an answer from KMS for a different key than the one asked for", async () => {
    const { kms, provider } = setup();
    const envelope = await encryptJson(credentials, context, provider);
    // The right data key, but reported as coming from another key.
    const relabelling: KmsSender = {
      send: async (command) => ({
        ...(await kms.send(command)),
        KeyId: "arn:aws:kms:eu-west-1:111122223333:key/somebody-else",
      }),
    };
    await expect(
      decryptJson(envelope, context, new AwsKmsKeyProvider(ALIAS, relabelling)),
    ).rejects.toBeInstanceOf(DecryptionError);
  });

  it("claims only key ids it wrote", () => {
    const { keyArn, provider } = setup();
    expect(provider.canUnwrap(`aws-kms:${keyArn}`)).toBe(true);
    for (const keyId of [
      "local:0123456789abcdef",
      keyArn,
      `aws-kms:${ALIAS}`,
      "aws-kms:nonsense",
    ]) {
      expect(provider.canUnwrap(keyId)).toBe(false);
    }
  });
});

describe("RotatingKeyProvider and rewrapEnvelope", () => {
  const oldLocal = new LocalKeyProvider(randomBytes(32).toString("base64"));

  it("reads records under the old key, and writes new ones under the new key", async () => {
    const { provider: kmsProvider } = setup();
    const rotating = new RotatingKeyProvider(kmsProvider, [oldLocal]);
    const old = await encryptJson(credentials, context, oldLocal);
    expect((await decryptJson(old, context, rotating)).expose()).toEqual(credentials);
    const fresh = await encryptJson(credentials, context, rotating);
    expect(fresh.keyId).toMatch(/^aws-kms:/);
    // A key no configured provider owns does not decrypt.
    const stranger = new LocalKeyProvider(randomBytes(32).toString("base64"));
    await expect(
      decryptJson(await encryptJson(credentials, context, stranger), context, rotating),
    ).rejects.toBeInstanceOf(DecryptionError);
  });

  it("re-wraps only the data key: the value's ciphertext is untouched and still decrypts", async () => {
    const { provider: kmsProvider } = setup();
    const rotating = new RotatingKeyProvider(kmsProvider, [oldLocal]);
    const old = await encryptJson(credentials, context, oldLocal);
    const moved = await rewrapEnvelope(old, context, rotating);
    expect(moved).toMatchObject({ iv: old.iv, ciphertext: old.ciphertext, tag: old.tag });
    expect(moved.keyId).toMatch(/^aws-kms:/);
    expect(moved.wrappedKey).not.toBe(old.wrappedKey);
    expect((await decryptJson(moved, context, kmsProvider)).expose()).toEqual(credentials);
  });

  it("refuses to re-wrap a damaged record, without asking for a new wrapping", async () => {
    const { kms, provider: kmsProvider } = setup();
    const rotating = new RotatingKeyProvider(kmsProvider, [oldLocal]);
    const old = await encryptJson(credentials, context, oldLocal);
    const ciphertext = Buffer.from(old.ciphertext, "base64");
    ciphertext[0]! ^= 1;
    await expect(
      rewrapEnvelope({ ...old, ciphertext: ciphertext.toString("base64") }, context, rotating),
    ).rejects.toBeInstanceOf(DecryptionError);
    await expect(
      rewrapEnvelope(old, { ...context, recordId: randomUUID() }, rotating),
    ).rejects.toBeInstanceOf(DecryptionError);
    expect(kms.calls).toEqual([]);
  });

  it("reports the key service being down while re-wrapping as such", async () => {
    const { kms, provider: kmsProvider } = setup();
    const envelope = await encryptJson(credentials, context, kmsProvider);
    kms.failNext("ThrottlingException");
    await expect(rewrapEnvelope(envelope, context, kmsProvider)).rejects.toBeInstanceOf(
      KeyServiceUnavailableError,
    );
  });
});

describe("createKeyProviderFromEnv with AWS KMS", () => {
  const KEY = "arn:aws:kms:eu-west-1:111122223333:key/1111aaaa-0000-4000-8000-000000000001";

  it("builds the KMS provider for a key or alias ARN, in production too, with the key's region", () => {
    const built: { keyId: string; region: string | undefined }[] = [];
    const factories = {
      awsKms: (options: { keyId: string; region: string | undefined }) => {
        built.push(options);
        return new AwsKmsKeyProvider(options.keyId, new FakeKms());
      },
    };
    for (const keyId of [KEY, ALIAS]) {
      expect(
        createKeyProviderFromEnv(
          {
            NODE_ENV: "production",
            VALTREXIA_KEY_PROVIDER: "aws-kms",
            VALTREXIA_KMS_KEY_ID: keyId,
          },
          factories,
        ),
      ).toBeInstanceOf(AwsKmsKeyProvider);
    }
    createKeyProviderFromEnv(
      { VALTREXIA_KEY_PROVIDER: "aws-kms", VALTREXIA_KMS_KEY_ID: KEY, AWS_REGION: "us-east-1" },
      factories,
    );
    expect(built.map((b) => b.region)).toEqual(["eu-west-1", "eu-west-1", "us-east-1"]);
  });

  it("builds a real client without contacting AWS", () => {
    expect(
      createKeyProviderFromEnv({ VALTREXIA_KEY_PROVIDER: "aws-kms", VALTREXIA_KMS_KEY_ID: KEY }),
    ).toBeInstanceOf(AwsKmsKeyProvider);
  });

  it.each([
    undefined,
    "",
    "alias/valtrexia",
    "1111aaaa-0000-4000-8000-000000000001",
    "arn:aws:s3:::bucket",
  ])("refuses the key id %j", (keyId) => {
    expect(() =>
      createKeyProviderFromEnv({ VALTREXIA_KEY_PROVIDER: "aws-kms", VALTREXIA_KMS_KEY_ID: keyId }),
    ).toThrow(/must be the ARN/);
  });

  it("adds earlier local keys for reading, outside production only", async () => {
    const previous = randomBytes(32).toString("base64");
    const provider = createKeyProviderFromEnv({
      VALTREXIA_LOCAL_KEK: randomBytes(32).toString("base64"),
      VALTREXIA_PREVIOUS_LOCAL_KEKS: ` ${previous} , `,
    });
    expect(provider).toBeInstanceOf(RotatingKeyProvider);
    const old = await encryptJson(credentials, context, new LocalKeyProvider(previous));
    expect((await decryptJson(old, context, provider)).expose()).toEqual(credentials);

    expect(() =>
      createKeyProviderFromEnv({
        NODE_ENV: "production",
        VALTREXIA_KEY_PROVIDER: "aws-kms",
        VALTREXIA_KMS_KEY_ID: KEY,
        VALTREXIA_PREVIOUS_LOCAL_KEKS: previous,
      }),
    ).toThrow(/not allowed in production/);
  });
});
