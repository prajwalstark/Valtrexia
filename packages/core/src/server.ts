// Server-only entry point: code that needs Node APIs (crypto, streams).
// Import from "@valtrexia/core/server". Never import this from client components.
export {
  DecryptionError,
  decryptJson,
  encryptJson,
  type EncryptedEnvelope,
  type EncryptionContext,
} from "./crypto/envelope";
export {
  createKeyProviderFromEnv,
  LocalKeyProvider,
  type KeyProvider,
  type KeyProviderEnv,
} from "./crypto/key-provider";
export { Secret } from "./crypto/secret";
export { createLogger, type CreateLoggerOptions, type Logger } from "./logging/logger";
export { isSensitiveKey, redact, REDACTED, scrubString } from "./logging/redact";
export {
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
