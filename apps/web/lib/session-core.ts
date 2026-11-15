import { recordAudit, upsertUser, type Db, type UserRole } from "@valtrexia/db";

/**
 * The decision about who is asking, kept free of any identity-provider code
 * so it can be tested exhaustively. `lib/auth.ts` feeds it from Clerk and
 * turns its answer into redirects.
 */

/** What the identity provider's verified session says about the request. */
export interface AuthSnapshot {
  /** Null when nobody is signed in. */
  clerkUserId: string | null;
  /** The active organization, if one is selected. */
  clerkOrgId: string | null;
  /** The user's role in that organization, for example "org:admin". */
  orgRole: string | null;
  /**
   * Minutes since the first and second factor were verified in this session.
   * -1 means that factor has not been verified in this session at all.
   */
  factorVerificationAge: readonly [number, number] | null;
}

/** Lookups against the identity provider. Each is a network call, so they are made lazily. */
export interface IdentityLookup {
  getUser(): Promise<{ email: string; name: string | null; twoFactorEnabled: boolean }>;
  getOrganizationName(clerkOrgId: string): Promise<string>;
}

export interface TenantSession {
  tenantId: string;
  /** Our `users.id` for this person in this tenant. */
  userId: string;
  clerkUserId: string;
  role: UserRole;
}

export type SessionDecision =
  | { kind: "signed-out" }
  | { kind: "mfa-required" }
  | { kind: "no-organization" }
  | { kind: "ok"; session: TenantSession };

/** Organization admins are owners. Every other member is a technician. */
export function roleFromOrgRole(orgRole: string | null): UserRole {
  return orgRole === "org:admin" ? "owner" : "technician";
}

/** Whether the session token alone proves a second factor was used. */
export function secondFactorVerified(age: AuthSnapshot["factorVerificationAge"]): boolean {
  return age !== null && Number.isFinite(age[1]) && age[1] >= 0;
}

/**
 * Works out whether a request may proceed and, if so, as which tenant and
 * user. In order:
 *
 *   1. Signed in?
 *   2. Multi-factor authentication. Proven either by the session token (a
 *      second factor was verified in this session) or by the identity
 *      provider confirming the account has one enrolled. No exceptions and
 *      no configuration switch.
 *   3. An organization selected?
 *   4. The tenant for that organization, created on first sight.
 *   5. The user's record in that tenant, created or updated to match.
 *
 * The tenant id comes only from the verified session's organization, never
 * from anything the browser can choose.
 */
export async function resolveSession(
  db: Db,
  auth: AuthSnapshot,
  lookup: IdentityLookup,
  options: { ip?: string | null } = {},
): Promise<SessionDecision> {
  if (!auth.clerkUserId) return { kind: "signed-out" };

  // Fetch the profile at most once, and only if something needs it.
  let profile: ReturnType<IdentityLookup["getUser"]> | undefined;
  const getProfile = () => (profile ??= lookup.getUser());

  if (!secondFactorVerified(auth.factorVerificationAge)) {
    if (!(await getProfile()).twoFactorEnabled) return { kind: "mfa-required" };
  }

  if (!auth.clerkOrgId) return { kind: "no-organization" };

  let tenantId = await db.resolveTenantId(auth.clerkOrgId);
  let provisioned = false;
  if (!tenantId) {
    // The organization webhook has not arrived, or is not configured (local
    // development). Create the tenant now; provisioning is idempotent.
    const name = await lookup.getOrganizationName(auth.clerkOrgId);
    tenantId = await db.provisionTenant({ clerkOrgId: auth.clerkOrgId, name });
    provisioned = true;
  }

  const role = roleFromOrgRole(auth.orgRole);
  const clerkUserId = auth.clerkUserId;

  const findKnown = (id: string) =>
    db.withTenant(id, ({ tx, tenantId: scoped }) =>
      tx.user.findUnique({
        where: { tenantId_clerkUserId: { tenantId: scoped, clerkUserId } },
        select: { id: true, role: true, deactivatedAt: true },
      }),
    );

  // Fast path: a known, active user whose role has not changed. One read.
  const known = await findKnown(tenantId);
  if (known && known.role === role && known.deactivatedAt === null && !provisioned) {
    return { kind: "ok", session: { tenantId, userId: known.id, clerkUserId, role } };
  }

  // Slow path: first visit, a role change, or a returning member. The
  // profile is fetched before the transaction opens, never inside it.
  const { email, name } = await getProfile();
  const resolvedTenantId = tenantId;
  let user: { id: string };
  try {
    user = await db.withTenant(resolvedTenantId, async (context) => {
      const result = await upsertUser(
        context,
        { clerkUserId, email, name, role },
        { actor: "self", ip: options.ip ?? null },
      );
      if (provisioned) {
        await recordAudit(context, {
          action: "tenant.provisioned",
          actorUserId: result.user.id,
          targetType: "tenant",
          targetId: context.tenantId,
          ip: options.ip ?? null,
        });
      }
      return result.user;
    });
  } catch (error) {
    // A page load fires several requests at once, and on a first visit they
    // race to create the same user. The loser hits the unique constraint;
    // by then the winner's row exists, so read it instead of failing.
    const winner = await findKnown(resolvedTenantId);
    if (!winner || winner.role !== role || winner.deactivatedAt !== null) throw error;
    user = winner;
  }

  return { kind: "ok", session: { tenantId, userId: user.id, clerkUserId, role } };
}
