import { randomUUID } from "node:crypto";
import type { VendorId } from "@valtrexia/core";
import {
  decryptJson,
  encryptJson,
  type EncryptedEnvelope,
  type KeyProvider,
  type Secret,
} from "@valtrexia/core/server";
import type { TenantContext } from "../db";
import type { Prisma } from "../generated/prisma/client";

/**
 * Columns that are safe to hand to the interface. `credentialsEnc` is left
 * out on purpose: even encrypted, it has no business leaving the server.
 */
export const integrationSummarySelect = {
  id: true,
  vendor: true,
  name: true,
  credentialHint: true,
  lastSyncAt: true,
  lastSyncStartedAt: true,
  syncStatus: true,
  lastSyncError: true,
  createdAt: true,
} satisfies Prisma.IntegrationSelect;

export type IntegrationSummary = Prisma.IntegrationGetPayload<{
  select: typeof integrationSummarySelect;
}>;

export interface CreateIntegrationInput {
  vendor: VendorId;
  name: string;
  /** Plaintext credentials. Encrypted before they are written; never stored as given. */
  credentials: Secret<unknown>;
  /** A short, non-secret reminder of which credentials these are, for the interface. */
  credentialHint?: string | null;
  /** Who is doing this, for the audit log. Null for system actions such as seeding. */
  actorUserId: string | null;
}

function credentialContext(tenantId: string, integrationId: string) {
  return { tenantId, recordId: integrationId, purpose: "integration-credentials" } as const;
}

/**
 * Creates an integration with its credentials encrypted, and records it in
 * the audit log. The audit entry names the vendor but holds nothing derived
 * from the credentials.
 */
export async function createIntegration(
  { tx, tenantId }: TenantContext,
  keyProvider: KeyProvider,
  input: CreateIntegrationInput,
): Promise<IntegrationSummary> {
  // The id is chosen first because the ciphertext is bound to it.
  const id = randomUUID();
  const envelope = await encryptJson(
    input.credentials.expose(),
    credentialContext(tenantId, id),
    keyProvider,
  );

  const integration = await tx.integration.create({
    data: {
      id,
      tenantId,
      vendor: input.vendor,
      name: input.name,
      credentialsEnc: envelope satisfies EncryptedEnvelope,
      credentialHint: input.credentialHint ?? null,
    },
    select: integrationSummarySelect,
  });

  await tx.auditLog.create({
    data: {
      tenantId,
      actorType: input.actorUserId ? "user" : "system",
      actorUserId: input.actorUserId,
      action: "integration.created",
      targetType: "integration",
      targetId: id,
      metadata: { vendor: input.vendor, name: input.name },
    },
  });

  return integration;
}

/**
 * Decrypts an integration's credentials. Server-side use only: the worker's
 * sync job and the "test connection" action. The result is a `Secret`; do not
 * return it from an API route or pass it to the logger.
 */
export async function decryptIntegrationCredentials(
  { tenantId }: Pick<TenantContext, "tenantId">,
  keyProvider: KeyProvider,
  integration: { id: string; credentialsEnc: unknown },
): Promise<Secret<unknown>> {
  return decryptJson(
    integration.credentialsEnc,
    credentialContext(tenantId, integration.id),
    keyProvider,
  );
}
