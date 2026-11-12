import { createHttpClient, type HttpClient, type HttpClientOptions } from "../http";
import type { DattoCredentials } from "./credentials";

/** Datto's public REST API. Overridable for tests, and only from server configuration. */
export const DATTO_DEFAULT_BASE_URL = "https://api.datto.com/v1";

export interface DattoClientOptions extends Pick<
  HttpClientOptions,
  "fetch" | "logger" | "sleep" | "random" | "maxRetries"
> {
  baseUrl?: string;
}

/**
 * An HTTP client authenticated to Datto. The API uses HTTP Basic auth with
 * the public key as the user name and the secret key as the password.
 *
 * The header is built on each request from a closure, so the keys are never
 * stored on an object that could be logged or serialized.
 */
export function createDattoClient(
  credentials: DattoCredentials,
  options: DattoClientOptions = {},
): HttpClient {
  const { baseUrl = DATTO_DEFAULT_BASE_URL, ...rest } = options;
  return createHttpClient({
    baseUrl,
    headers: () => ({
      authorization: `Basic ${Buffer.from(
        `${credentials.publicKey}:${credentials.secretKey}`,
        "utf8",
      ).toString("base64")}`,
    }),
    // Datto's published rate limits are not confirmed; stay conservative.
    maxConcurrency: 2,
    ...rest,
  });
}
