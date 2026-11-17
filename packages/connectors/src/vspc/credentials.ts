import { z } from "zod";

/**
 * Veeam Service Provider Console credentials: where the console is, and an
 * API key for it.
 *
 * Each MSP runs its own console, so the address comes from the person
 * connecting it. It is checked here for shape only; whether it may be
 * reached at all is decided at every request by the outbound guard, which
 * refuses private and internal addresses.
 *
 * The key should be created in VSPC with read-only access ("isReadAccessOnly"
 * and the "rest" scope), so that even our own code could not change anything
 * with it.
 */

/**
 * The console's address as entered, made into the root the API lives under:
 * https only, no user name or password, no query or fragment, and any
 * trailing "/api/v3" or slash removed. A path is kept, for a console behind
 * a reverse proxy at a sub-path. The REST API's default port is 1280.
 */
export function normalizeServerUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    return null;
  }
  const path = url.pathname.replace(/\/+$/, "").replace(/\/api\/v3$/i, "");
  return `${url.origin}${path}`;
}

export const vspcCredentialsSchema = z.strictObject({
  serverUrl: z
    .string()
    .max(2048)
    .transform((value, context) => {
      const normalized = normalizeServerUrl(value);
      if (normalized === null) {
        context.addIssue({
          code: "custom",
          message: "Enter the console's https address, for example https://vspc.example.com:1280.",
        });
        return z.NEVER;
      }
      return normalized;
    }),
  apiKey: z
    .string()
    .trim()
    .min(16, "That key looks too short.")
    .max(1024, "That key looks too long.")
    .regex(/^[\x21-\x7e]+$/, "The key cannot contain spaces or special characters."),
});
export type VspcCredentials = z.infer<typeof vspcCredentialsSchema>;

/** Where the REST API is, under the console's address. */
export function vspcApiBase(serverUrl: string): string {
  return `${serverUrl}/api/v3`;
}

/**
 * A short reminder of which console and key this is, safe to show: the
 * console's host and the last four characters of the key.
 */
export function vspcCredentialHint(credentials: VspcCredentials): string {
  return `${new URL(credentials.serverUrl).host}, key ending ${credentials.apiKey.slice(-4)}`;
}
