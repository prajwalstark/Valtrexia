import type { TenantContext } from "../db";
import type { User, UserRole } from "../generated/prisma/client";
import { recordAudit } from "./audit";

export interface UserIdentity {
  clerkUserId: string;
  email: string;
  name: string | null;
  role: UserRole;
}

export type UserChange = "created" | "updated" | "reactivated" | "unchanged";

/**
 * Makes our record of a tenant member match the identity provider's: creates
 * the row on first sight, follows role changes, and reactivates someone who
 * was removed and has been added back. Every change is audited.
 *
 * `actor` is who caused it: "self" when a person signs in, "system" when the
 * identity provider tells us through a webhook.
 */
export async function upsertUser(
  context: TenantContext,
  identity: UserIdentity,
  options: { actor: "self" | "system"; ip?: string | null } = { actor: "system" },
): Promise<{ user: User; change: UserChange }> {
  const { tx, tenantId } = context;
  const where = { tenantId_clerkUserId: { tenantId, clerkUserId: identity.clerkUserId } };
  const existing = await tx.user.findUnique({ where });

  if (!existing) {
    const user = await tx.user.create({
      data: {
        tenantId,
        clerkUserId: identity.clerkUserId,
        email: identity.email,
        name: identity.name,
        role: identity.role,
      },
    });
    await recordAudit(context, {
      action: "user.joined",
      actorUserId: options.actor === "self" ? user.id : null,
      targetType: "user",
      targetId: user.id,
      metadata: { role: identity.role },
      ip: options.ip ?? null,
    });
    return { user, change: "created" };
  }

  const reactivating = existing.deactivatedAt !== null;
  const roleChanged = existing.role !== identity.role;
  const profileChanged = existing.email !== identity.email || existing.name !== identity.name;
  if (!reactivating && !roleChanged && !profileChanged)
    return { user: existing, change: "unchanged" };

  const user = await tx.user.update({
    where: { id: existing.id },
    data: {
      email: identity.email,
      name: identity.name,
      role: identity.role,
      deactivatedAt: null,
    },
  });
  const actorUserId = options.actor === "self" ? user.id : null;
  if (reactivating) {
    await recordAudit(context, {
      action: "user.reactivated",
      actorUserId,
      targetType: "user",
      targetId: user.id,
      metadata: { role: identity.role },
      ip: options.ip ?? null,
    });
  }
  if (roleChanged) {
    await recordAudit(context, {
      action: "user.role_changed",
      actorUserId,
      targetType: "user",
      targetId: user.id,
      metadata: { from: existing.role, to: identity.role },
      ip: options.ip ?? null,
    });
  }
  return { user, change: reactivating ? "reactivated" : "updated" };
}

/**
 * Marks a member as removed. The row stays, so audit entries and incident
 * acknowledgements remain attributable. Returns false if there was nothing
 * to do.
 */
export async function deactivateUser(
  context: TenantContext,
  clerkUserId: string,
): Promise<boolean> {
  const { tx, tenantId } = context;
  const existing = await tx.user.findUnique({
    where: { tenantId_clerkUserId: { tenantId, clerkUserId } },
  });
  if (!existing || existing.deactivatedAt) return false;

  await tx.user.update({ where: { id: existing.id }, data: { deactivatedAt: new Date() } });
  await recordAudit(context, {
    action: "user.deactivated",
    actorUserId: null,
    targetType: "user",
    targetId: existing.id,
  });
  return true;
}
