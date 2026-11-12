import "server-only";
import { isIP } from "node:net";
import { auth, clerkClient, currentUser } from "@clerk/nextjs/server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getSafeDb } from "./db";
import {
  resolveSession,
  type IdentityLookup,
  type SessionDecision,
  type TenantSession,
} from "./session-core";

export type { TenantSession } from "./session-core";

/** The caller is signed in to this tenant but is not allowed to do this. */
export class ForbiddenError extends Error {
  constructor() {
    super("Only workspace owners can do this.");
    this.name = "ForbiddenError";
  }
}

/** Best-effort client address for the audit log. Informational, not trusted. */
async function clientIp(): Promise<string | null> {
  const forwarded = (await headers()).get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first && isIP(first) ? first : null;
}

const identityLookup: IdentityLookup = {
  async getUser() {
    const user = await currentUser();
    if (!user) throw new Error("The signed-in user could not be loaded.");
    return {
      email: user.primaryEmailAddress?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? "",
      name: [user.firstName, user.lastName].filter(Boolean).join(" ") || null,
      twoFactorEnabled: user.twoFactorEnabled,
    };
  },
  async getOrganizationName(organizationId) {
    const client = await clerkClient();
    return (await client.organizations.getOrganization({ organizationId })).name;
  },
};

/**
 * Who is making this request. Resolved once per request (React `cache`), so
 * a layout and the page inside it share one answer.
 */
export const getSessionDecision = cache(async (): Promise<SessionDecision> => {
  const session = await auth();
  return resolveSession(
    await getSafeDb(),
    {
      clerkUserId: session.userId ?? null,
      clerkOrgId: session.orgId ?? null,
      orgRole: session.orgRole ?? null,
      factorVerificationAge: session.factorVerificationAge ?? null,
    },
    identityLookup,
    { ip: await clientIp() },
  );
});

/**
 * The tenant and user for this request, or a redirect to whatever must
 * happen first: sign in, set up multi-factor authentication, or choose a
 * workspace.
 *
 * Call this at the top of every page, server action and route handler that
 * touches tenant data. A layout calling it does not protect a server action.
 */
export async function requireTenant(): Promise<TenantSession> {
  const decision = await getSessionDecision();
  switch (decision.kind) {
    case "signed-out":
      return redirect("/sign-in");
    case "mfa-required":
      return redirect("/mfa-required");
    case "no-organization":
      return redirect("/onboarding");
    case "ok":
      return decision.session;
  }
}

/** As `requireTenant`, and additionally requires the owner role. */
export async function requireOwner(): Promise<TenantSession> {
  const session = await requireTenant();
  if (session.role !== "owner") throw new ForbiddenError();
  return session;
}
