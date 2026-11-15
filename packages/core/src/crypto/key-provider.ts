import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Wraps and unwraps data keys with a key-encryption key that this process may
 * or may not hold itself. In production the key stays inside a KMS and this
 * interface is a network call; in development it is a local key.
 */
export interface KeyProvider {
  /** Encrypts a data key. `aad` binds the result to its context. */
  wrapKey(dataKey: Buffer, aad: Buffer): Promise<{ keyId: string; wrappedKey: Buffer }>;
  /** Reverses `wrapKey`. Must fail if `aad` or `keyId` differ from those used to wrap. */
  unwrapKey(wrappedKey: Buffer, keyId: string, aad: Buffer): Promise<Buffer>;
}

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Development key provider: wraps data keys with AES-256-GCM under a key read
 * from configuration. Not for production, where the key-encryption key must
 * live in a KMS rather than beside the data it protects.
 */
export class LocalKeyProvider implements KeyProvider {
  readonly #kek: Buffer;
  /** Identifies which key wrapped a data key, without revealing the key. */
  readonly keyId: string;

  /** @param base64Key 32 random bytes, base64-encoded (`openssl rand -base64 32`). */
  constructor(base64Key: string) {
    const kek = Buffer.from(base64Key, "base64");
    if (kek.length !== KEY_BYTES) {
      throw new Error(
        "The local key-encryption key must be 32 bytes, base64-encoded. " +
          "Generate one with: openssl rand -base64 32",
      );
    }
    this.#kek = kek;
    this.keyId = `local:${createHash("sha256").update(kek).digest("hex").slice(0, 16)}`;
  }

  async wrapKey(dataKey: Buffer, aad: Buffer): Promise<{ keyId: string; wrappedKey: Buffer }> {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.#kek, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()]);
    return {
      keyId: this.keyId,
      wrappedKey: Buffer.concat([iv, cipher.getAuthTag(), ciphertext]),
    };
  }

  async unwrapKey(wrappedKey: Buffer, keyId: string, aad: Buffer): Promise<Buffer> {
    if (keyId !== this.keyId) {
      throw new Error("The data key was wrapped with a different key-encryption key.");
    }
    if (wrappedKey.length <= IV_BYTES + TAG_BYTES) throw new Error("Wrapped key is malformed.");
    const iv = wrappedKey.subarray(0, IV_BYTES);
    const tag = wrappedKey.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = wrappedKey.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", this.#kek, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }
}

export interface KeyProviderEnv {
  NODE_ENV?: string | undefined;
  VALTREXIA_KEY_PROVIDER?: string | undefined;
  VALTREXIA_LOCAL_KEK?: string | undefined;
}

/**
 * Builds the key provider named by configuration.
 *
 * `local` is refused when NODE_ENV is "production": a key that sits in the
 * same environment as the database does not protect the database's contents.
 */
export function createKeyProviderFromEnv(env: KeyProviderEnv): KeyProvider {
  const kind = env.VALTREXIA_KEY_PROVIDER ?? "local";

  if (kind === "local") {
    if (env.NODE_ENV === "production") {
      throw new Error(
        "VALTREXIA_KEY_PROVIDER=local is not allowed in production. Configure a KMS key provider.",
      );
    }
    if (!env.VALTREXIA_LOCAL_KEK) {
      throw new Error("VALTREXIA_LOCAL_KEK is not set. Generate one with: openssl rand -base64 32");
    }
    return new LocalKeyProvider(env.VALTREXIA_LOCAL_KEK);
  }

  if (kind === "kms") {
    // The production provider is written once the cloud KMS is chosen
    // (open decision 4 in PLAN.md). It implements the same interface.
    throw new Error("The KMS key provider is not implemented yet.");
  }

  throw new Error(`Unknown VALTREXIA_KEY_PROVIDER: expected "local" or "kms".`);
}
