import type { Logger } from "@valtrexia/core/server";
import { z } from "zod";
import {
  AuthError,
  InvalidResponseError,
  NetworkError,
  RateLimitError,
  VendorError,
} from "../errors";
import type { UniviewCredentials } from "./credentials";

/** Where UniView issues access tokens, from its documentation. Fixed: never taken from input. */
export const UNIVIEW_TOKEN_URL = "https://login.backup.net/connect/token";

const tokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().nullish(),
  expires_in: z.number().nullish(),
});

export interface TokenOptions {
  fetch?: typeof fetch;
  logger?: Logger;
  /** Retries after the first attempt, for network failures and server errors. Default 2. */
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Overrides the token address. Tests only. */
  tokenUrl?: string;
  timeoutMs?: number;
}

/**
 * Exchanges the client ID and secret for an access token: the OAuth 2.0
 * client credentials grant, with the ID and secret as HTTP Basic auth.
 *
 * This is the one request a connector makes that is not a GET. It goes to
 * one fixed address, carries one form field, and changes nothing in anyone's
 * backups; the data itself is still read through the GET-only client.
 *
 * The token is returned to the caller and kept in memory for one sync; it is
 * never stored or logged.
 */
export async function fetchUniviewToken(
  credentials: UniviewCredentials,
  options: TokenOptions = {},
): Promise<string> {
  const doFetch = options.fetch ?? fetch;
  const maxRetries = options.maxRetries ?? 2;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const basic = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`, "utf8").toString(
    "base64",
  );

  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      response = await doFetch(options.tokenUrl ?? UNIVIEW_TOKEN_URL, {
        method: "POST",
        headers: {
          authorization: `Basic ${basic}`,
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: "grant_type=client_credentials",
        redirect: "manual",
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      });
    } catch (cause) {
      if (attempt >= maxRetries) {
        const timedOut =
          cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
        throw new NetworkError(timedOut, { cause });
      }
      await sleep(500 * 2 ** attempt);
      continue;
    }

    options.logger?.debug({ status: response.status, attempt }, "uniview token request");
    if (response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new InvalidResponseError("token response is not JSON");
      }
      const parsed = tokenSchema.safeParse(body);
      if (!parsed.success) throw new InvalidResponseError("token response has no access token");
      return parsed.data.access_token;
    }
    await response.body?.cancel().catch(() => undefined);
    // OAuth servers answer a bad client with 400 invalid_client, or 401.
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new AuthError(response.status);
    }
    if (response.status === 429) throw new RateLimitError(null);
    if (response.status >= 500 && attempt < maxRetries) {
      await sleep(500 * 2 ** attempt);
      continue;
    }
    throw new VendorError(response.status);
  }
}
