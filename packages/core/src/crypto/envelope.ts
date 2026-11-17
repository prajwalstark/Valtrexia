import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
import { KeyServiceUnavailableError, type KeyProvider } from "./key-provider";
import { Secret } from "./secret";

/**
 * Envelope encryption for vendor credentials.
 *
 * Each value is encrypted with its own random data key (AES-256-GCM). The
 * data key is then wrapped by the key provider and stored beside the
 * ciphertext. Reading the database alone yields nothing usable; rotating the
 * key-encryption key means re-wrapping small data keys, not re-encrypting data.
 *
 * Both layers are bound to an encryption context (tenant, record and purpose)
 * as additional authenticated data. A ciphertext copied onto another tenant's
 * row, or onto another integration, fails authentication and will not decrypt.
 */

const DATA_KEY_BYTES = 32;
const IV_BYTES = 12;

export interface EncryptionContext {
  tenantId: string;
  /** The record the value belongs to, for example an integration id. */
  recordId: string;
  /** What the value is, so the same record can hold more than one secret. */
  purpose: "integration-credentials" | "notification-channel";
}

const envelopeSchema = z.strictObject({
  v: z.literal(1),
  alg: z.literal("AES-256-GCM"),
  keyId: z.string().min(1),
  wrappedKey: z.base64(),
  iv: z.base64(),
  ciphertext: z.base64(),
  tag: z.base64(),
});

/** What is stored in the database. Safe to persist; useless without the key provider. */
export type EncryptedEnvelope = z.infer<typeof envelopeSchema>;

/**
 * Raised for every decryption failure: wrong context, wrong key, tampering or
 * a malformed envelope. The cause is deliberately not distinguished, so an
 * error message can never help someone probing stored ciphertexts.
 */
export class DecryptionError extends Error {
  constructor() {
    super("The value could not be decrypted.");
    this.name = "DecryptionError";
  }
}

function contextBytes(context: EncryptionContext): Buffer {
  for (const part of [context.tenantId, context.recordId, context.purpose]) {
    if (!part || part.includes("|")) throw new Error("Invalid encryption context.");
  }
  return Buffer.from(`v1|${context.purpose}|${context.tenantId}|${context.recordId}`, "utf8");
}

/** Encrypts a JSON-serializable value for storage. */
export async function encryptJson(
  value: unknown,
  context: EncryptionContext,
  keyProvider: KeyProvider,
): Promise<EncryptedEnvelope> {
  const aad = contextBytes(context);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const dataKey = randomBytes(DATA_KEY_BYTES);
  try {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const { keyId, wrappedKey } = await keyProvider.wrapKey(dataKey, aad);
    return {
      v: 1,
      alg: "AES-256-GCM",
      keyId,
      wrappedKey: wrappedKey.toString("base64"),
      iv: iv.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: tag.toString("base64"),
    };
  } finally {
    dataKey.fill(0);
    plaintext.fill(0);
  }
}

/**
 * Decrypts a stored envelope. The result is wrapped in `Secret` so it cannot
 * be logged or serialized by accident.
 *
 * @throws DecryptionError if the envelope is malformed, was tampered with, was
 *   encrypted under a different key, or belongs to a different context.
 * @throws KeyServiceUnavailableError if the key service could not answer;
 *   nothing is known to be wrong with the value, and a retry can succeed.
 */
export async function decryptJson<T = unknown>(
  envelope: unknown,
  context: EncryptionContext,
  keyProvider: KeyProvider,
): Promise<Secret<T>> {
  let dataKey: Buffer | undefined;
  try {
    const parsed = envelopeSchema.parse(envelope);
    const aad = contextBytes(context);
    dataKey = await keyProvider.unwrapKey(
      Buffer.from(parsed.wrappedKey, "base64"),
      parsed.keyId,
      aad,
    );
    const decipher = createDecipheriv("aes-256-gcm", dataKey, Buffer.from(parsed.iv, "base64"));
    decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(parsed.ciphertext, "base64")),
      decipher.final(),
    ]);
    try {
      return new Secret(JSON.parse(plaintext.toString("utf8")) as T);
    } finally {
      plaintext.fill(0);
    }
  } catch (error) {
    if (error instanceof KeyServiceUnavailableError) throw error;
    throw new DecryptionError();
  } finally {
    dataKey?.fill(0);
  }
}

/**
 * Re-wraps a stored envelope's data key with the key provider's current key,
 * for key rotation. The value's own ciphertext, IV and tag are kept as they
 * are; only the small wrapped data key changes.
 *
 * Before re-wrapping, the data key is checked against the ciphertext's
 * authentication tag, so a damaged record is reported rather than given a
 * fresh wrapping. That check passes the value through memory once, and the
 * buffer is zeroed at once; the value is never returned.
 *
 * @throws DecryptionError, KeyServiceUnavailableError as `decryptJson` does.
 */
export async function rewrapEnvelope(
  envelope: unknown,
  context: EncryptionContext,
  keyProvider: KeyProvider,
): Promise<EncryptedEnvelope> {
  let dataKey: Buffer | undefined;
  let parsed: EncryptedEnvelope;
  let aad: Buffer;
  try {
    parsed = envelopeSchema.parse(envelope);
    aad = contextBytes(context);
    dataKey = await keyProvider.unwrapKey(
      Buffer.from(parsed.wrappedKey, "base64"),
      parsed.keyId,
      aad,
    );
    const decipher = createDecipheriv("aes-256-gcm", dataKey, Buffer.from(parsed.iv, "base64"));
    decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(parsed.ciphertext, "base64")),
      decipher.final(),
    ]);
    plaintext.fill(0);
  } catch (error) {
    dataKey?.fill(0);
    if (error instanceof KeyServiceUnavailableError) throw error;
    throw new DecryptionError();
  }
  try {
    const { keyId, wrappedKey } = await keyProvider.wrapKey(dataKey, aad);
    return { ...parsed, keyId, wrappedKey: wrappedKey.toString("base64") };
  } finally {
    dataKey.fill(0);
  }
}

/** The key id an envelope's data key is wrapped under, or null if it is not an envelope. */
export function envelopeKeyId(envelope: unknown): string | null {
  const parsed = envelopeSchema.safeParse(envelope);
  return parsed.success ? parsed.data.keyId : null;
}
