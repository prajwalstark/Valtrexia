// Server-only entry point: code that needs Node APIs (crypto, streams).
// Import from "@valtrexia/core/server". Never import this from client components.
export {
  DecryptionError,
  decryptJson,
  encryptJson,
  envelopeKeyId,
  rewrapEnvelope,
  type EncryptedEnvelope,
  type EncryptionContext,
} from "./crypto/envelope";
export { AwsKmsKeyProvider, type KmsSender } from "./crypto/aws-kms";
export {
  createKeyProviderFromEnv,
  type KeyProviderEnv,
  type KeyProviderFactories,
} from "./crypto/config";
export {
  KeyServiceUnavailableError,
  LocalKeyProvider,
  RotatingKeyProvider,
  type KeyProvider,
} from "./crypto/key-provider";
export { Secret } from "./crypto/secret";
export { createLogger, type CreateLoggerOptions, type Logger } from "./logging/logger";
export { isSensitiveKey, redact, REDACTED, scrubString } from "./logging/redact";
export {
  createGuardedFetch,
  type GuardedFetchOptions,
  isPublicAddress,
  OutboundFailedError,
  outboundPolicyFromEnv,
  OutboundRefusedError,
  parseOutboundUrl,
  postJson,
  resolvePublicAddresses,
  type OutboundPolicy,
  type OutboundRefusal,
  type PostJsonOptions,
  type ResolvedAddress,
  type Resolver,
} from "./net/outbound";
export {
  generateWebhookSecret,
  signWebhook,
  verifyWebhook,
  type WebhookMessage,
} from "./notifications/webhook-signature";
export {
  createEmailSenderFromEnv,
  EmailSendError,
  LogEmailSender,
  MAX_EMAIL_RECIPIENTS,
  MemoryEmailSender,
  type EmailMessage,
  type EmailSender,
} from "./notifications/email-sender";
