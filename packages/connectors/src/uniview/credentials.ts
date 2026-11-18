import { z } from "zod";

/**
 * Kaseya UniView (Unitrends) public API credentials: a client ID and client
 * secret, created in the UniView Portal under API Access. They are exchanged
 * for a short-lived access token with the OAuth 2.0 client credentials flow.
 */
const part = z
  .string()
  .trim()
  .min(8, "That looks too short.")
  .max(512, "That looks too long.")
  .regex(/^[\x21-\x7e]+$/, "It cannot contain spaces or special characters.");

export const univiewCredentialsSchema = z.strictObject({
  clientId: part,
  clientSecret: part,
});
export type UniviewCredentials = z.infer<typeof univiewCredentialsSchema>;

/** The last four characters of the client ID: safe to show, nothing from the secret. */
export function univiewCredentialHint(credentials: UniviewCredentials): string {
  return credentials.clientId.slice(-4);
}
