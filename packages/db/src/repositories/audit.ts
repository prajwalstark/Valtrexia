import type { TenantContext } from "../db";
import type { Prisma } from "../generated/prisma/client";

export interface AuditEntry {
  /** Dotted verb: `integration.created`, `user.joined`, ... */
  action: string;
  /** The acting user's id in our `users` table, or null for the system. */
  actorUserId: string | null;
  targetType?: string;
  targetId?: string;
  /** Context for the action. Never credentials, tokens or vendor payloads. */
  metadata?: Prisma.InputJsonObject;
  ip?: string | null;
}

/**
 * Appends to the audit log. Entries cannot be changed or removed afterwards:
 * the runtime database role has no UPDATE or DELETE on the table.
 *
 * Call it inside the same transaction as the change it describes, so the
 * record and the change succeed or fail together.
 */
export async function recordAudit(
  { tx, tenantId }: TenantContext,
  entry: AuditEntry,
): Promise<void> {
  await tx.auditLog.create({
    data: {
      tenantId,
      actorType: entry.actorUserId ? "user" : "system",
      actorUserId: entry.actorUserId,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      metadata: entry.metadata ?? {},
      ip: entry.ip ?? null,
    },
  });
}
