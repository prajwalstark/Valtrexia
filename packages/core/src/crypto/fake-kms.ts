import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { DecryptCommand, EncryptCommand } from "@aws-sdk/client-kms";
import type { KmsSender } from "./aws-kms";

/**
 * A stand-in for AWS KMS, for tests. It behaves as KMS documents for the two
 * operations used: Encrypt accepts a key or alias ARN and answers with the
 * key's ARN; the ciphertext names the key it was made with; the encryption
 * context is bound in and must match exactly to decrypt; Decrypt given a
 * different key than the ciphertext's fails with IncorrectKeyException; a
 * disabled key fails with DisabledException. Errors carry KMS's names.
 */
export class FakeKms implements KmsSender {
  readonly #keys = new Map<string, { material: Buffer; enabled: boolean }>();
  readonly #aliases = new Map<string, string>();
  #failures: string[] = [];
  /** Every call made, without plaintext: the operation, the key named and the context. */
  readonly calls: {
    op: "Encrypt" | "Decrypt";
    keyId?: string;
    context?: Record<string, string>;
  }[] = [];

  /** Creates a key, and optionally an alias for it. Returns the key's ARN. */
  createKey(name: string, alias?: string): string {
    const arn = `arn:aws:kms:eu-west-1:111122223333:key/${name}`;
    this.#keys.set(arn, { material: randomBytes(32), enabled: true });
    if (alias) this.#aliases.set(`arn:aws:kms:eu-west-1:111122223333:alias/${alias}`, arn);
    return arn;
  }

  /** Points an alias at another key, as an operator would to rotate. */
  pointAlias(alias: string, keyArn: string): void {
    this.#aliases.set(`arn:aws:kms:eu-west-1:111122223333:alias/${alias}`, keyArn);
  }

  setEnabled(keyArn: string, enabled: boolean): void {
    this.#keys.get(keyArn)!.enabled = enabled;
  }

  /** Makes the next calls fail with these error names, in order. */
  failNext(...names: string[]): void {
    this.#failures.push(...names);
  }

  async send(command: EncryptCommand | DecryptCommand) {
    const failure = this.#failures.shift();
    if (failure) throw kmsError(failure);

    if (command instanceof EncryptCommand) {
      const { KeyId, Plaintext, EncryptionContext } = command.input;
      this.calls.push({ op: "Encrypt", keyId: KeyId!, context: EncryptionContext! });
      const arn = this.#resolve(KeyId);
      const key = this.#usable(arn);
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key.material, iv);
      cipher.setAAD(contextBytes(EncryptionContext));
      const body = Buffer.concat([cipher.update(Plaintext!), cipher.final()]);
      const arnBytes = Buffer.from(arn, "utf8");
      return {
        CiphertextBlob: Buffer.concat([
          Buffer.from([arnBytes.length]),
          arnBytes,
          iv,
          cipher.getAuthTag(),
          body,
        ]),
        KeyId: arn,
      };
    }

    const { KeyId, CiphertextBlob, EncryptionContext } = command.input;
    this.calls.push({
      op: "Decrypt",
      ...(KeyId ? { keyId: KeyId } : {}),
      context: EncryptionContext!,
    });
    const blob = Buffer.from(CiphertextBlob!);
    const arnLength = blob[0] ?? 0;
    const arn = blob.subarray(1, 1 + arnLength).toString("utf8");
    if (!this.#keys.has(arn)) throw kmsError("InvalidCiphertextException");
    if (KeyId && this.#resolve(KeyId) !== arn) throw kmsError("IncorrectKeyException");
    const key = this.#usable(arn);
    const rest = blob.subarray(1 + arnLength);
    try {
      const decipher = createDecipheriv("aes-256-gcm", key.material, rest.subarray(0, 12));
      decipher.setAAD(contextBytes(EncryptionContext));
      decipher.setAuthTag(rest.subarray(12, 28));
      const plaintext = Buffer.concat([decipher.update(rest.subarray(28)), decipher.final()]);
      return { Plaintext: new Uint8Array(plaintext), KeyId: arn };
    } catch {
      throw kmsError("InvalidCiphertextException");
    }
  }

  #resolve(keyId: string | undefined): string {
    const arn = keyId ? (this.#aliases.get(keyId) ?? keyId) : "";
    if (!this.#keys.has(arn)) throw kmsError("NotFoundException");
    return arn;
  }

  #usable(arn: string) {
    const key = this.#keys.get(arn)!;
    if (!key.enabled) throw kmsError("DisabledException");
    return key;
  }
}

function contextBytes(context: Record<string, string> | undefined): Buffer {
  const entries = Object.entries(context ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return Buffer.from(JSON.stringify(entries), "utf8");
}

function kmsError(name: string): Error {
  const error = new Error(`${name}: (fake KMS)`);
  error.name = name;
  return error;
}
