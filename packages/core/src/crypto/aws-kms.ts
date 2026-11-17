import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";
import { KeyServiceUnavailableError, type KeyProvider } from "./key-provider";

/** Prefix of the key ids this provider writes: `aws-kms:` and the KMS key's ARN. */
const PREFIX = "aws-kms:";
const KEY_ARN = /^arn:aws[\w-]*:kms:[\w-]+:\d{12}:key\/[\w-]+$/;

/**
 * KMS errors meaning "this does not decrypt": the context or the key does not
 * match, or the ciphertext was altered. Anything else (throttling, an outage,
 * a disabled or missing key, a denied permission, a timeout) means "try again
 * later", and must not tell a tenant to re-enter their credentials.
 */
const NOT_DECRYPTABLE = new Set(["InvalidCiphertextException", "IncorrectKeyException"]);

/** The two KMS operations this provider uses. A `KMSClient` satisfies it; tests pass a fake. */
export interface KmsSender {
  send(command: EncryptCommand | DecryptCommand): Promise<{
    CiphertextBlob?: Uint8Array;
    Plaintext?: Uint8Array;
    KeyId?: string;
  }>;
}

/**
 * Wraps data keys with an AWS KMS symmetric key. The key never leaves KMS.
 *
 * The envelope's authenticated data (purpose, tenant and record) is passed as
 * KMS encryption context, so KMS itself refuses to unwrap a data key copied
 * onto another tenant's or another record's row, and every call is recorded in
 * CloudTrail with the record it was for. No data key is cached: each unwrap is
 * one KMS call, which keeps a revoked permission effective at once.
 *
 * Calls need `kms:Encrypt` on the current key and `kms:Decrypt` on every key
 * records may still be wrapped under.
 */
export class AwsKmsKeyProvider implements KeyProvider {
  readonly #client: KmsSender;
  readonly #keyId: string;

  /**
   * @param keyId The key that wraps new data keys: a key ARN or alias ARN.
   * @param client Sends the KMS requests.
   */
  constructor(keyId: string, client: KmsSender) {
    this.#keyId = keyId;
    this.#client = client;
  }

  /** A provider with a real KMS client: three attempts, short timeouts. */
  static create(options: { keyId: string; region: string | undefined }): AwsKmsKeyProvider {
    const client = new KMSClient({
      ...(options.region ? { region: options.region } : {}),
      maxAttempts: 3,
      requestHandler: { connectionTimeout: 3_000, requestTimeout: 5_000 },
    });
    return new AwsKmsKeyProvider(options.keyId, client);
  }

  async wrapKey(dataKey: Buffer, aad: Buffer): Promise<{ keyId: string; wrappedKey: Buffer }> {
    let response;
    try {
      response = await this.#client.send(
        new EncryptCommand({
          KeyId: this.#keyId,
          Plaintext: dataKey,
          EncryptionContext: encryptionContext(aad),
          EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
        }),
      );
    } catch (cause) {
      throw new KeyServiceUnavailableError({ cause: errorName(cause) });
    }
    if (!response.CiphertextBlob || !response.KeyId || !KEY_ARN.test(response.KeyId)) {
      throw new KeyServiceUnavailableError({ cause: "unexpected Encrypt response" });
    }
    return {
      keyId: `${PREFIX}${response.KeyId}`,
      wrappedKey: Buffer.from(response.CiphertextBlob),
    };
  }

  async unwrapKey(wrappedKey: Buffer, keyId: string, aad: Buffer): Promise<Buffer> {
    if (!this.canUnwrap(keyId)) throw new Error("Not a KMS key id.");
    const keyArn = keyId.slice(PREFIX.length);
    let response;
    try {
      response = await this.#client.send(
        new DecryptCommand({
          // Named, so KMS refuses a ciphertext that was made with any other key.
          KeyId: keyArn,
          CiphertextBlob: wrappedKey,
          EncryptionContext: encryptionContext(aad),
          EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
        }),
      );
    } catch (cause) {
      if (NOT_DECRYPTABLE.has(errorName(cause))) throw new Error("The data key did not unwrap.");
      throw new KeyServiceUnavailableError({ cause: errorName(cause) });
    }
    if (!response.Plaintext || response.KeyId !== keyArn) {
      throw new Error("The data key did not unwrap.");
    }
    const dataKey = Buffer.from(response.Plaintext);
    response.Plaintext.fill(0);
    return dataKey;
  }

  canUnwrap(keyId: string): boolean {
    return keyId.startsWith(PREFIX) && KEY_ARN.test(keyId.slice(PREFIX.length));
  }
}

/**
 * The envelope's authenticated data as KMS encryption context. It is plain
 * text (`v1|purpose|tenant|record`), holds no secret, and so is readable in
 * CloudTrail.
 */
function encryptionContext(aad: Buffer): Record<string, string> {
  return { valtrexia: aad.toString("utf8") };
}

/** The SDK error's name, and nothing else: messages can quote request details. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
