import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Wraps and unwraps data keys with a key-encryption key that this process may
 * or may not hold itself. In production the key stays inside a KMS and this
 * interface is a network call; in development it is a local key.
 */
export interface KeyProvider {
  /** Encrypts a data key. `aad` binds the result to its context. */
  wrapKey(dataKey: Buffer, aad: Buffer): Promise<{ keyId: string; wrappedKey: Buffer }>;
  /**
   * Reverses `wrapKey`. Must fail if `aad` or `keyId` differ from those used
   * to wrap. Throws `KeyServiceUnavailableError` when the answer is "try
   * again later" rather than "this does not decrypt".
   */
  unwrapKey(wrappedKey: Buffer, keyId: string, aad: Buffer): Promise<Buffer>;
  /** Whether this provider is the one that can unwrap data keys wrapped under `keyId`. */
  canUnwrap(keyId: string): boolean;
}

/**
 * The key service could not answer: unreachable, throttled, not permitted,
 * or the key is disabled. Unlike a decryption failure, nothing is wrong with
 * the stored value, and retrying later can succeed. The message is ours and
 * safe to show; it names no key and carries no ciphertext.
 */
export class KeyServiceUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("The encryption key service could not be reached.", options);
    this.name = "KeyServiceUnavailableError";
  }
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

  canUnwrap(keyId: string): boolean {
    return keyId === this.keyId;
  }
}

/**
 * Wraps new data keys with one provider and unwraps with whichever provider
 * owns a record's key id. This is how a key is rotated without downtime: the
 * new key wraps everything written from now on, the old one still reads what
 * was written before, and the rotation command moves the old records across.
 */
export class RotatingKeyProvider implements KeyProvider {
  readonly #current: KeyProvider;
  readonly #all: readonly KeyProvider[];

  constructor(current: KeyProvider, previous: readonly KeyProvider[] = []) {
    this.#current = current;
    this.#all = [current, ...previous];
  }

  wrapKey(dataKey: Buffer, aad: Buffer): Promise<{ keyId: string; wrappedKey: Buffer }> {
    return this.#current.wrapKey(dataKey, aad);
  }

  unwrapKey(wrappedKey: Buffer, keyId: string, aad: Buffer): Promise<Buffer> {
    const owner = this.#all.find((provider) => provider.canUnwrap(keyId));
    if (!owner) throw new Error("No configured key can unwrap this data key.");
    return owner.unwrapKey(wrappedKey, keyId, aad);
  }

  canUnwrap(keyId: string): boolean {
    return this.#all.some((provider) => provider.canUnwrap(keyId));
  }
}
