import { AwsKmsKeyProvider } from "./aws-kms";
import { LocalKeyProvider, RotatingKeyProvider, type KeyProvider } from "./key-provider";

export interface KeyProviderEnv {
  NODE_ENV?: string | undefined;
  VALTREXIA_KEY_PROVIDER?: string | undefined;
  VALTREXIA_LOCAL_KEK?: string | undefined;
  /** Earlier local keys, comma-separated, kept only to read records not yet rotated. */
  VALTREXIA_PREVIOUS_LOCAL_KEKS?: string | undefined;
  /** The AWS KMS key that wraps new data keys: a key ARN or an alias ARN. */
  VALTREXIA_KMS_KEY_ID?: string | undefined;
  AWS_REGION?: string | undefined;
}

export interface KeyProviderFactories {
  /** Builds the AWS KMS provider. Replaceable for tests. */
  awsKms?: (options: { keyId: string; region: string | undefined }) => KeyProvider;
}

/**
 * Builds the key provider named by configuration.
 *
 * - `local`: a key from configuration. Refused when NODE_ENV is "production":
 *   a key that sits in the same environment as the database does not protect
 *   the database's contents.
 * - `aws-kms`: AWS KMS. The key never leaves KMS; credentials come from the
 *   AWS SDK's usual sources (an IAM role in production).
 *
 * Earlier local keys can be listed so records wrapped under them are still
 * read until the rotation command has moved them. Not in production, where
 * no record can have been wrapped by a local key.
 */
export function createKeyProviderFromEnv(
  env: KeyProviderEnv,
  factories: KeyProviderFactories = {},
): KeyProvider {
  const kind = env.VALTREXIA_KEY_PROVIDER ?? "local";
  const production = env.NODE_ENV === "production";

  let current: KeyProvider;
  if (kind === "local") {
    if (production) {
      throw new Error("VALTREXIA_KEY_PROVIDER=local is not allowed in production. Use aws-kms.");
    }
    if (!env.VALTREXIA_LOCAL_KEK) {
      throw new Error("VALTREXIA_LOCAL_KEK is not set. Generate one with: openssl rand -base64 32");
    }
    current = new LocalKeyProvider(env.VALTREXIA_LOCAL_KEK);
  } else if (kind === "aws-kms") {
    const keyId = env.VALTREXIA_KMS_KEY_ID?.trim();
    if (!keyId || !/^arn:aws[\w-]*:kms:[\w-]+:\d{12}:(key|alias)\/[\w/-]+$/.test(keyId)) {
      throw new Error(
        "VALTREXIA_KMS_KEY_ID must be the ARN of a KMS key or alias, for example " +
          "arn:aws:kms:eu-west-1:111122223333:alias/valtrexia.",
      );
    }
    const build = factories.awsKms ?? ((options) => AwsKmsKeyProvider.create(options));
    current = build({ keyId, region: env.AWS_REGION ?? keyId.split(":")[3] });
  } else {
    throw new Error('Unknown VALTREXIA_KEY_PROVIDER: expected "local" or "aws-kms".');
  }

  const previousKeks = (env.VALTREXIA_PREVIOUS_LOCAL_KEKS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (previousKeks.length === 0) return current;
  if (production) {
    throw new Error("VALTREXIA_PREVIOUS_LOCAL_KEKS is not allowed in production.");
  }
  return new RotatingKeyProvider(
    current,
    previousKeks.map((kek) => new LocalKeyProvider(kek)),
  );
}
