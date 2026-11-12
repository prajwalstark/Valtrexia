import "server-only";
import { createKeyProviderFromEnv, type KeyProvider } from "@valtrexia/core/server";

let provider: KeyProvider | undefined;

/** The key provider that wraps credential data keys. Built once per process. */
export function getKeyProvider(): KeyProvider {
  provider ??= createKeyProviderFromEnv(process.env);
  return provider;
}
