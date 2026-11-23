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
export { assertProductionTransport } from "./net/transport";
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
export { RESEND_API_URL, ResendEmailSender, type ResendOptions } from "./notifications/resend";
export {
  evaluateFleet,
  OPERATOR_CONDITIONS,
  OPERATOR_THRESHOLDS,
  renderOperatorAlert,
  type ConditionState,
  type FleetSnapshot,
  type OperatorAlertMessage,
  type OperatorCondition,
} from "./operator/conditions";
export { operatorAlertConfigFromEnv, type OperatorAlertConfig } from "./operator/config";
export {
  fleetSnapshotKey,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_STALE_MS,
  heartbeatAt,
  heartbeatKey,
  heartbeatKeyPattern,
  isHeartbeatFresh,
  maintenanceStatusKey,
  REDIS_PREFIX,
  type Heartbeat,
} from "./operator/keys";
export {
  failureFor as syncroFailureFor,
  PsaError,
  SYNCRO_SUBDOMAIN,
  syncroBaseUrl,
  SyncroClient,
  syncroMessage,
  type PsaCustomer,
  type PsaTicket,
  type SyncroClientOptions,
  type SyncroCredentials,
} from "./psa/syncro";
export { isClosedStatus, refInSubject, ticketNews, ticketRef, ticketSubject } from "./psa/tickets";
