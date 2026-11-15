import { z } from "zod";

/** One key of a Datto REST API key pair: printable, no spaces, sensible length. */
const apiKey = z
  .string()
  .trim()
  .min(4, "That key looks too short.")
  .max(200, "That key looks too long.")
  .regex(/^[\x21-\x7e]+$/, "Keys cannot contain spaces or special characters.");

/**
 * Datto BCDR REST API credentials: a public key and a secret key, created
 * as a pair in the Datto Partner Portal.
 */
export const dattoCredentialsSchema = z.strictObject({
  publicKey: apiKey,
  secretKey: apiKey,
});
export type DattoCredentials = z.infer<typeof dattoCredentialsSchema>;

/**
 * A short reminder of which key pair this is, safe to store in the clear and
 * show in the interface: the last four characters of the public key. Nothing
 * is derived from the secret key.
 */
export function dattoCredentialHint(publicKey: string): string {
  return publicKey.trim().slice(-4);
}
