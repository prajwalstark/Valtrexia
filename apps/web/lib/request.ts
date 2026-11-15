import "server-only";
import { isIP } from "node:net";
import { headers } from "next/headers";

/**
 * Best-effort client address, for the audit log. It comes from a header the
 * client or a proxy can set, so it is recorded as information and never used
 * to make a decision.
 */
export async function clientIp(): Promise<string | null> {
  const first = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim();
  return first && isIP(first) ? first : null;
}
