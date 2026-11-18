import { deleteAfterFor, type DeletionReason } from "@valtrexia/core";
import type { TenantContext } from "../db";
import { recordAudit } from "./audit";

export interface PendingDeletion {
  requestedAt: Date;
  deleteAfter: Date;
  reason: DeletionReason;
}

/** The workspace's pending deletion, or null when there is none. */
export async function getPendingDeletion({
  tx,
  tenantId,
}: TenantContext): Promise<PendingDeletion | null> {
  const row = await tx.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { deletionRequestedAt: true, deleteAfter: true, deletionReason: true },
  });
  return row.deletionRequestedAt && row.deleteAfter && row.deletionReason
    ? {
        requestedAt: row.deletionRequestedAt,
        deleteAfter: row.deleteAfter,
        reason: row.deletionReason,
      }
    : null;
}

/**
 * Marks the workspace for deletion after the hold. Syncing and notifications
 * stop from the next scheduler tick. If it is already marked, nothing
 * changes: a repeated request never moves the date later or earlier.
 */
export async function requestTenantDeletion(
  context: TenantContext,
  input: { reason: DeletionReason; now: Date; actorUserId: string | null; ip?: string | null },
): Promise<{ pending: PendingDeletion; changed: boolean }> {
  const existing = await getPendingDeletion(context);
  if (existing) return { pending: existing, changed: false };
  const pending: PendingDeletion = {
    requestedAt: input.now,
    deleteAfter: deleteAfterFor(input.now),
    reason: input.reason,
  };
  await context.tx.tenant.update({
    where: { id: context.tenantId },
    data: {
      deletionRequestedAt: pending.requestedAt,
      deleteAfter: pending.deleteAfter,
      deletionReason: pending.reason,
    },
  });
  await recordAudit(context, {
    action: "workspace.deletion_requested",
    actorUserId: input.actorUserId,
    targetType: "tenant",
    targetId: context.tenantId,
    metadata: { reason: pending.reason, deleteAfter: pending.deleteAfter.toISOString() },
    ip: input.ip ?? null,
  });
  return { pending, changed: true };
}

/** Clears a pending deletion. Returns false when there was none. */
export async function cancelTenantDeletion(
  context: TenantContext,
  input: { actorUserId: string | null; ip?: string | null },
): Promise<boolean> {
  const existing = await getPendingDeletion(context);
  if (!existing) return false;
  await context.tx.tenant.update({
    where: { id: context.tenantId },
    data: { deletionRequestedAt: null, deleteAfter: null, deletionReason: null },
  });
  await recordAudit(context, {
    action: "workspace.deletion_cancelled",
    actorUserId: input.actorUserId,
    targetType: "tenant",
    targetId: context.tenantId,
    metadata: { reason: existing.reason },
    ip: input.ip ?? null,
  });
  return true;
}
