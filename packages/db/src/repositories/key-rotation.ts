import {
  envelopeKeyId,
  rewrapEnvelope,
  type EncryptionContext,
  type KeyProvider,
} from "@valtrexia/core/server";
import type { Db, EncryptedRecordRef } from "../db";
import type { Prisma } from "../generated/prisma/client";
import { recordAudit } from "./audit";

export type RewrapOutcome =
  /** Its data key is now wrapped under the current key. */
  | "rewrapped"
  /** It already was. */
  | "current"
  /** It changed while being re-wrapped, so it was left alone; a new value is written under the current key anyway. */
  | "changed"
  /** It no longer exists, or no longer holds an encrypted value. */
  | "gone";

function contextOf(ref: Pick<EncryptedRecordRef, "tenantId" | "type" | "id">): EncryptionContext {
  return {
    tenantId: ref.tenantId,
    recordId: ref.id,
    purpose: ref.type === "integration" ? "integration-credentials" : "notification-channel",
  };
}

/**
 * Re-wraps one record's data key under the key provider's current key.
 *
 * Three steps, so no transaction is held open across a call to the key
 * service: read the envelope; re-wrap it (the value itself is not
 * re-encrypted, see `rewrapEnvelope`); write it back only if the stored
 * envelope is still the one that was read. A record replaced in the meantime
 * is left as it is: its new value was written under the current key.
 *
 * @throws DecryptionError when the record cannot be read with any configured
 *   key, and KeyServiceUnavailableError when the key service did not answer.
 */
export async function rewrapRecord(
  db: Db,
  keyProvider: KeyProvider,
  ref: Pick<EncryptedRecordRef, "tenantId" | "type" | "id">,
  currentKeyId: string,
): Promise<{ outcome: RewrapOutcome; fromKeyId?: string }> {
  const found = await db.withTenant(ref.tenantId, async ({ tx }) => {
    if (ref.type === "integration") {
      const row = await tx.integration.findUnique({
        where: { id: ref.id },
        select: { credentialsEnc: true, name: true },
      });
      return row ? { envelope: row.credentialsEnc, name: row.name } : null;
    }
    const row = await tx.notificationChannel.findUnique({
      where: { id: ref.id },
      select: { secretEnc: true, name: true },
    });
    return row?.secretEnc ? { envelope: row.secretEnc, name: row.name } : null;
  });
  if (found === null) return { outcome: "gone" };
  const { envelope: stored, name } = found;
  const fromKeyId = envelopeKeyId(stored) ?? "unknown";
  if (fromKeyId === currentKeyId) return { outcome: "current" };

  const rewrapped = await rewrapEnvelope(stored, contextOf(ref), keyProvider);
  const previous = stored as Prisma.InputJsonValue;
  const next = rewrapped as unknown as Prisma.InputJsonValue;

  return db.withTenant(ref.tenantId, async (context) => {
    const { count } =
      ref.type === "integration"
        ? await context.tx.integration.updateMany({
            where: { id: ref.id, credentialsEnc: { equals: previous } },
            data: { credentialsEnc: next },
          })
        : await context.tx.notificationChannel.updateMany({
            where: { id: ref.id, secretEnc: { equals: previous } },
            data: { secretEnc: next },
          });
    if (count === 0) return { outcome: "changed" as const, fromKeyId };
    await recordAudit(context, {
      action: "encryption.rewrapped",
      actorUserId: null,
      targetType: ref.type,
      targetId: ref.id,
      metadata: { name, fromKeyId, toKeyId: rewrapped.keyId },
    });
    return { outcome: "rewrapped" as const, fromKeyId };
  });
}
