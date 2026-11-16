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

/**
 * Appends several entries at once, for one action that changed many things:
 * each thing still gets its own entry, so its history can be read on its own.
 */
export async function recordAudits(
  { tx, tenantId }: TenantContext,
  entries: AuditEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  await tx.auditLog.createMany({
    data: entries.map((entry) => ({
      tenantId,
      actorType: entry.actorUserId ? ("user" as const) : ("system" as const),
      actorUserId: entry.actorUserId,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      metadata: entry.metadata ?? {},
      ip: entry.ip ?? null,
    })),
  });
}
