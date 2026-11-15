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
