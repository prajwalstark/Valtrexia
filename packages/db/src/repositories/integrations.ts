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
import { recordAudit } from "./audit";

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
  ip?: string | null;
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

  await recordAudit(
    { tx, tenantId },
    {
      action: "integration.created",
      actorUserId: input.actorUserId,
      targetType: "integration",
      targetId: id,
      metadata: { vendor: input.vendor, name: input.name },
      ip: input.ip ?? null,
    },
  );

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

/** An integration with this name already exists in the tenant. */
export class IntegrationNameTakenError extends Error {
  constructor() {
    super("An integration with this name already exists.");
    this.name = "IntegrationNameTakenError";
  }
}

/** Every integration in the tenant, oldest first, without credentials. */
export async function listIntegrations({ tx }: TenantContext): Promise<IntegrationSummary[]> {
  return tx.integration.findMany({
    orderBy: { createdAt: "asc" },
    select: integrationSummarySelect,
  });
}

/** One integration without credentials, or null if this tenant has no such integration. */
export async function getIntegrationSummary(
  { tx }: TenantContext,
  id: string,
): Promise<IntegrationSummary | null> {
  return tx.integration.findUnique({ where: { id }, select: integrationSummarySelect });
}

/** Whether the tenant already has an integration called `name`. */
export async function integrationNameExists({ tx }: TenantContext, name: string): Promise<boolean> {
  return (await tx.integration.count({ where: { name } })) > 0;
}

/**
 * Loads and decrypts an integration's credentials. Server-side only, for the
 * sync job and the connection test. Returns null if this tenant has no such
 * integration.
 */
export async function loadIntegrationCredentials(
  { tx, tenantId }: TenantContext,
  keyProvider: KeyProvider,
  id: string,
): Promise<{ vendor: VendorId; name: string; credentials: Secret<unknown> } | null> {
  const row = await tx.integration.findUnique({
    where: { id },
    select: { id: true, vendor: true, name: true, credentialsEnc: true },
  });
  if (!row) return null;
  return {
    vendor: row.vendor,
    name: row.name,
    credentials: await decryptIntegrationCredentials({ tenantId }, keyProvider, row),
  };
}

export interface ReplaceCredentialsInput {
  id: string;
  credentials: Secret<unknown>;
  credentialHint?: string | null;
  actorUserId: string | null;
  ip?: string | null;
}

/**
 * Replaces an integration's credentials with a freshly encrypted set and
 * makes it due for a sync straight away. Returns null if this tenant has no
 * such integration.
 */
export async function replaceIntegrationCredentials(
  { tx, tenantId }: TenantContext,
  keyProvider: KeyProvider,
  input: ReplaceCredentialsInput,
): Promise<IntegrationSummary | null> {
  const existing = await tx.integration.findUnique({
    where: { id: input.id },
    select: { id: true, vendor: true, lastSyncAt: true },
  });
  if (!existing) return null;

  const envelope = await encryptJson(
    input.credentials.expose(),
    credentialContext(tenantId, existing.id),
    keyProvider,
  );
  const updated = await tx.integration.update({
    where: { id: existing.id },
    data: {
      credentialsEnc: envelope satisfies EncryptedEnvelope,
      credentialHint: input.credentialHint ?? null,
      // Clear the old failure and let the scheduler pick it up now.
      lastSyncError: null,
      lastSyncStartedAt: null,
      syncStatus: existing.lastSyncAt ? "ok" : "never",
    },
    select: integrationSummarySelect,
  });
  await recordAudit(
    { tx, tenantId },
    {
      action: "integration.credentials_replaced",
      actorUserId: input.actorUserId,
      targetType: "integration",
      targetId: existing.id,
      metadata: { vendor: existing.vendor },
      ip: input.ip ?? null,
    },
  );
  return updated;
}

/**
 * Deletes an integration together with the assets, results and incidents
 * that came from it. Clients are kept: they belong to the MSP, and another
 * vendor may feed them. Returns what was removed, or null if this tenant has
 * no such integration.
 */
export async function deleteIntegration(
  { tx, tenantId }: TenantContext,
  input: { id: string; actorUserId: string | null; ip?: string | null },
): Promise<{ name: string; assetsRemoved: number } | null> {
  const existing = await tx.integration.findUnique({
    where: { id: input.id },
    select: { id: true, vendor: true, name: true, _count: { select: { assets: true } } },
  });
  if (!existing) return null;

  await tx.integration.delete({ where: { id: existing.id } });
  await recordAudit(
    { tx, tenantId },
    {
      action: "integration.deleted",
      actorUserId: input.actorUserId,
      targetType: "integration",
      targetId: existing.id,
      metadata: {
        vendor: existing.vendor,
        name: existing.name,
        assetsRemoved: existing._count.assets,
      },
      ip: input.ip ?? null,
    },
  );
  return { name: existing.name, assetsRemoved: existing._count.assets };
}
