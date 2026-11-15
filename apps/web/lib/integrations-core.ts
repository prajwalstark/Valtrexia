import {
  AuthError,
  ConnectorError,
  createConnector,
  dattoCredentialHint,
  dattoCredentialsSchema,
  NetworkError,
  RateLimitError,
  VendorError,
  type ConnectorDeps,
} from "@valtrexia/connectors";
import { getVendor, type VendorId } from "@valtrexia/core";
import { DecryptionError, Secret, type KeyProvider, type Logger } from "@valtrexia/core/server";
import {
  createIntegration,
  deleteIntegration,
  getIntegrationSummary,
  integrationNameExists,
  listIntegrations,
  loadIntegrationCredentials,
  recordAudit,
  replaceIntegrationCredentials,
  type Db,
  type IntegrationSummary,
} from "@valtrexia/db";
import { z } from "zod";
import type { RateLimiter } from "./rate-limit";
import type { TenantSession } from "./session-core";

/**
 * Everything the integrations pages do, with no framework code in it so it
 * can be tested directly. The server actions in lib/actions/integrations.ts
 * are thin wrappers that supply the session and these dependencies.
 *
 * Two rules hold for every function here:
 *   - Credentials go in, and never come back out. Nothing returned from this
 *     module contains a key, a ciphertext or anything derived from a secret.
 *   - Only owners may test, save, replace or disconnect. The check is made
 *     here as well as by the caller, so no future caller can forget it.
 */

export interface IntegrationDeps {
  db: Db;
  keyProvider: KeyProvider;
  connectorDeps: ConnectorDeps;
  /** Limits connection tests per tenant. */
  limiter: RateLimiter;
  logger: Logger;
  ip?: string | null;
}

export type FieldErrors = Partial<Record<"name" | "publicKey" | "secretKey" | "confirm", string>>;

export type ActionState =
  | { status: "idle" }
  | { status: "ok"; message: string; integrationId?: string }
  | { status: "error"; message: string; fieldErrors?: FieldErrors };

const OWNERS_ONLY = "Only workspace owners can manage integrations.";
const NOT_FOUND = "That integration no longer exists.";
const TOO_MANY = "Too many connection tests. Wait a minute and try again.";

const dattoFormSchema = z.object({
  name: z
    .string()
    .trim()
    .max(60, "Use 60 characters or fewer.")
    .transform((value) => value || getVendor("datto_bcdr").name),
  publicKey: dattoCredentialsSchema.shape.publicKey,
  secretKey: dattoCredentialsSchema.shape.secretKey,
});

/** Field-level messages from a failed parse. The rejected values are never included. */
function fieldErrors(error: z.ZodError): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of error.issues) {
    const field = issue.path[0];
    if (field === "name" || field === "publicKey" || field === "secretKey") {
      out[field] ??= issue.code === "invalid_type" ? "This field is required." : issue.message;
    }
  }
  return out;
}

type TestOutcome = "ok" | "rejected" | "rate_limited" | "unreachable" | "vendor_error" | "failed";

/** Turns a connection-test failure into words for a technician, and a label for the audit log. */
function describeTestFailure(
  vendor: VendorId,
  error: unknown,
): { outcome: TestOutcome; message: string } {
  const name = getVendor(vendor).name;
  if (error instanceof AuthError) {
    return {
      outcome: "rejected",
      message: `${name} rejected these keys. Check that both were copied in full and that the key pair is active.`,
    };
  }
  if (error instanceof RateLimitError) {
    return {
      outcome: "rate_limited",
      message: `${name} is limiting requests right now. Wait a minute and try again.`,
    };
  }
  if (error instanceof NetworkError) {
    return { outcome: "unreachable", message: `${name} could not be reached. Try again shortly.` };
  }
  if (error instanceof VendorError) {
    return {
      outcome: "vendor_error",
      message: `${name} returned an error (HTTP ${error.status}). Try again shortly.`,
    };
  }
  if (error instanceof DecryptionError) {
    return {
      outcome: "failed",
      message: "The saved keys could not be read. Replace them with a new key pair.",
    };
  }
  if (error instanceof ConnectorError) return { outcome: "failed", message: error.message };
  return { outcome: "failed", message: "The connection test failed unexpectedly. Try again." };
}

async function runTest(
  deps: IntegrationDeps,
  session: TenantSession,
  vendor: VendorId,
  credentials: Secret<unknown>,
  integrationId: string | null,
): Promise<{ outcome: TestOutcome; message: string }> {
  let result: { outcome: TestOutcome; message: string };
  try {
    await createConnector(vendor, credentials, deps.connectorDeps).testConnection();
    result = {
      outcome: "ok",
      message: `Connected. ${getVendor(vendor).name} accepted these keys.`,
    };
  } catch (error) {
    result = describeTestFailure(vendor, error);
    if (result.outcome === "failed")
      deps.logger.error({ err: error, vendor }, "connection test failed");
  }

  await deps.db.withTenant(session.tenantId, (context) =>
    recordAudit(context, {
      action: "integration.connection_tested",
      actorUserId: session.userId,
      ...(integrationId ? { targetType: "integration", targetId: integrationId } : {}),
      metadata: { vendor, outcome: result.outcome },
      ip: deps.ip ?? null,
    }),
  );
  return result;
}

/** The tenant's integrations, for display. Contains no credentials. */
export async function listIntegrationsFor(
  deps: Pick<IntegrationDeps, "db">,
  session: TenantSession,
): Promise<IntegrationSummary[]> {
  return deps.db.withTenant(session.tenantId, (context) => listIntegrations(context));
}

/** One integration for display, or null. Contains no credentials. */
export async function getIntegrationFor(
  deps: Pick<IntegrationDeps, "db">,
  session: TenantSession,
  integrationId: string,
): Promise<IntegrationSummary | null> {
  if (!z.uuid().safeParse(integrationId).success) return null;
  return deps.db.withTenant(session.tenantId, (context) =>
    getIntegrationSummary(context, integrationId),
  );
}

/** Checks a Datto key pair without saving it. */
export async function testNewDattoCredentials(
  deps: IntegrationDeps,
  session: TenantSession,
  input: unknown,
): Promise<ActionState> {
  if (session.role !== "owner") return { status: "error", message: OWNERS_ONLY };
  const parsed = dattoFormSchema.safeParse(input);
  if (!parsed.success) {
    return {
      status: "error",
      message: "Check the highlighted fields.",
      fieldErrors: fieldErrors(parsed.error),
    };
  }
  if (!deps.limiter.take(session.tenantId)) return { status: "error", message: TOO_MANY };

  const { publicKey, secretKey } = parsed.data;
  const result = await runTest(
    deps,
    session,
    "datto_bcdr",
    new Secret({ publicKey, secretKey }),
    null,
  );
  return result.outcome === "ok"
    ? { status: "ok", message: result.message }
    : { status: "error", message: result.message };
}

/**
 * Saves a Datto key pair as a new integration. The keys are tested first and
 * only stored if Datto accepts them, so a typo is caught now rather than as a
 * failed sync fifteen minutes later.
 */
export async function connectDatto(
  deps: IntegrationDeps,
  session: TenantSession,
  input: unknown,
): Promise<ActionState> {
  if (session.role !== "owner") return { status: "error", message: OWNERS_ONLY };
  const parsed = dattoFormSchema.safeParse(input);
  if (!parsed.success) {
    return {
      status: "error",
      message: "Check the highlighted fields.",
      fieldErrors: fieldErrors(parsed.error),
    };
  }
  const { name, publicKey, secretKey } = parsed.data;

  const taken = await deps.db.withTenant(session.tenantId, (context) =>
    integrationNameExists(context, name),
  );
  if (taken) {
    return {
      status: "error",
      message: "Check the highlighted fields.",
      fieldErrors: { name: "An integration with this name already exists. Choose another." },
    };
  }
  if (!deps.limiter.take(session.tenantId)) return { status: "error", message: TOO_MANY };

  const credentials = new Secret({ publicKey, secretKey });
  const test = await runTest(deps, session, "datto_bcdr", credentials, null);
  if (test.outcome !== "ok") return { status: "error", message: `Not saved. ${test.message}` };

  const integration = await deps.db.withTenant(session.tenantId, (context) =>
    createIntegration(context, deps.keyProvider, {
      vendor: "datto_bcdr",
      name,
      credentials,
      credentialHint: dattoCredentialHint(publicKey),
      actorUserId: session.userId,
      ip: deps.ip ?? null,
    }),
  );
  return {
    status: "ok",
    message: `${name} is connected. The first sync starts within a few minutes.`,
    integrationId: integration.id,
  };
}

/** Tests an integration's stored credentials. They are decrypted on the server and go no further. */
export async function testSavedIntegration(
  deps: IntegrationDeps,
  session: TenantSession,
  integrationId: string,
): Promise<ActionState> {
  if (session.role !== "owner") return { status: "error", message: OWNERS_ONLY };
  if (!z.uuid().safeParse(integrationId).success) return { status: "error", message: NOT_FOUND };
  if (!deps.limiter.take(session.tenantId)) return { status: "error", message: TOO_MANY };

  let loaded;
  try {
    loaded = await deps.db.withTenant(session.tenantId, (context) =>
      loadIntegrationCredentials(context, deps.keyProvider, integrationId),
    );
  } catch (error) {
    const failure = describeTestFailure("datto_bcdr", error);
    deps.logger.error({ err: error, integrationId }, "could not load integration credentials");
    return { status: "error", message: failure.message };
  }
  if (!loaded) return { status: "error", message: NOT_FOUND };

  const result = await runTest(deps, session, loaded.vendor, loaded.credentials, integrationId);
  return result.outcome === "ok"
    ? { status: "ok", message: result.message }
    : { status: "error", message: result.message };
}

/** Replaces a Datto integration's key pair, after testing the new one. */
export async function replaceDattoCredentials(
  deps: IntegrationDeps,
  session: TenantSession,
  integrationId: string,
  input: unknown,
): Promise<ActionState> {
  if (session.role !== "owner") return { status: "error", message: OWNERS_ONLY };
  const existing = await getIntegrationFor(deps, session, integrationId);
  if (!existing || existing.vendor !== "datto_bcdr") return { status: "error", message: NOT_FOUND };

  const parsed = dattoFormSchema.omit({ name: true }).safeParse(input);
  if (!parsed.success) {
    return {
      status: "error",
      message: "Check the highlighted fields.",
      fieldErrors: fieldErrors(parsed.error),
    };
  }
  if (!deps.limiter.take(session.tenantId)) return { status: "error", message: TOO_MANY };

  const { publicKey, secretKey } = parsed.data;
  const credentials = new Secret({ publicKey, secretKey });
  const test = await runTest(deps, session, "datto_bcdr", credentials, integrationId);
  if (test.outcome !== "ok") return { status: "error", message: `Not saved. ${test.message}` };

  const updated = await deps.db.withTenant(session.tenantId, (context) =>
    replaceIntegrationCredentials(context, deps.keyProvider, {
      id: integrationId,
      credentials,
      credentialHint: dattoCredentialHint(publicKey),
      actorUserId: session.userId,
      ip: deps.ip ?? null,
    }),
  );
  if (!updated) return { status: "error", message: NOT_FOUND };
  return { status: "ok", message: "Keys replaced. The next sync uses the new key pair." };
}

/**
 * Removes an integration and the assets and backup history that came from
 * it. The caller must type the integration's name, so this cannot happen by
 * a stray click.
 */
export async function disconnectIntegration(
  deps: IntegrationDeps,
  session: TenantSession,
  integrationId: string,
  confirmName: unknown,
): Promise<ActionState> {
  if (session.role !== "owner") return { status: "error", message: OWNERS_ONLY };
  const existing = await getIntegrationFor(deps, session, integrationId);
  if (!existing) return { status: "error", message: NOT_FOUND };

  if (typeof confirmName !== "string" || confirmName.trim() !== existing.name) {
    return {
      status: "error",
      message: "Nothing was removed.",
      fieldErrors: { confirm: `Type ${existing.name} exactly to confirm.` },
    };
  }

  const removed = await deps.db.withTenant(session.tenantId, (context) =>
    deleteIntegration(context, {
      id: integrationId,
      actorUserId: session.userId,
      ip: deps.ip ?? null,
    }),
  );
  if (!removed) return { status: "error", message: NOT_FOUND };
  return {
    status: "ok",
    message: `${removed.name} was disconnected and ${removed.assetsRemoved} assets were removed.`,
  };
}
