import { randomBytes, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import {
  fakeUniview,
  FIXTURE_CLIENT_ID,
  FIXTURE_CLIENT_SECRET,
  univiewFixture,
} from "@valtrexia/connectors/uniview/fixtures";
import { createLogger, LocalKeyProvider } from "@valtrexia/core/server";
import { createDb, decryptIntegrationCredentials, type Db } from "@valtrexia/db";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  connectUniview,
  listIntegrationsFor,
  replaceUniviewCredentials,
  testNewUniviewCredentials,
  type IntegrationDeps,
} from "./integrations-core";
import { createRateLimiter } from "./rate-limit";
import type { TenantSession } from "./session-core";

const urls = inject("databaseUrls");
let db: Db;
const keyProvider = new LocalKeyProvider(randomBytes(32).toString("base64"));
const logLines: string[] = [];
const logger = createLogger({
  name: "uniview-integrations-test",
  level: "debug",
  destination: new Writable({
    write(chunk: Buffer, _encoding, done) {
      logLines.push(chunk.toString());
      done();
    },
  }),
});
beforeAll(() => {
  db = createDb({ url: urls.app });
});
afterAll(async () => {
  await db.disconnect();
});

function deps(fetchImpl: typeof fetch, overrides: Partial<IntegrationDeps> = {}): IntegrationDeps {
  return {
    db,
    keyProvider,
    connectorDeps: { allowMock: false, fetch: fetchImpl, maxRetries: 0, logger },
    limiter: createRateLimiter({ limit: 100, windowMs: 60_000 }),
    logger,
    ip: "203.0.113.9",
    ...overrides,
  };
}

async function newTenant(role: TenantSession["role"] = "owner"): Promise<TenantSession> {
  const tenantId = await db.provisionTenant({ clerkOrgId: `org_${randomUUID()}`, name: "MSP" });
  const user = await db.withTenant(tenantId, ({ tx }) =>
    tx.user.create({
      data: { tenantId, clerkUserId: `user_${randomUUID()}`, email: `${role}@msp.example`, role },
    }),
  );
  return { tenantId, userId: user.id, clerkUserId: user.clerkUserId, role };
}

const form = (overrides: Record<string, unknown> = {}) => ({
  name: "",
  clientId: ` ${FIXTURE_CLIENT_ID} `,
  clientSecret: FIXTURE_CLIENT_SECRET,
  ...overrides,
});

describe("connectUniview", () => {
  it("tests, then saves the client ID and secret encrypted, with a hint of the ID", async () => {
    const session = await newTenant();
    const uniview = fakeUniview();
    const state = await connectUniview(deps(uniview.fetch), session, form());
    expect(state).toMatchObject({
      status: "ok",
      message:
        "Kaseya UniView (Unitrends) is connected. The first sync starts within a few minutes.",
      integrationId: expect.any(String) as string,
    });
    // The connection test, before saving: a token and one customer.
    expect(uniview.requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
      "POST /connect/token",
      "GET /v1/customers",
    ]);

    const [integration] = await listIntegrationsFor({ db }, session);
    expect(integration).toMatchObject({
      vendor: "kaseya_uniview",
      name: "Kaseya UniView (Unitrends)",
      credentialHint: "0001",
    });
    expect(JSON.stringify(integration)).not.toContain(FIXTURE_CLIENT_SECRET);

    const stored = await db.withTenant(session.tenantId, ({ tx }) =>
      tx.integration.findUniqueOrThrow({ where: { id: integration!.id } }),
    );
    expect(JSON.stringify(stored.credentialsEnc)).not.toContain(FIXTURE_CLIENT_SECRET);
    const decrypted = await decryptIntegrationCredentials(
      { tenantId: session.tenantId },
      keyProvider,
      stored,
    );
    expect(decrypted.expose()).toEqual({
      clientId: FIXTURE_CLIENT_ID,
      clientSecret: FIXTURE_CLIENT_SECRET,
    });
  });

  it("saves nothing when UniView rejects the secret", async () => {
    const session = await newTenant();
    const state = await connectUniview(
      deps(fakeUniview(univiewFixture(), { clientSecret: "another-secret-entirely-0" }).fetch),
      session,
      form(),
    );
    expect(state).toEqual({
      status: "error",
      message:
        "Not saved. Kaseya UniView (Unitrends) rejected this client ID and secret. Check that both were copied in full and that the API client has not been deleted.",
    });
    expect(await listIntegrationsFor({ db }, session)).toEqual([]);
  });

  it("refuses a secret that cannot be one before testing, and does not echo it back", async () => {
    const session = await newTenant();
    const uniview = fakeUniview();
    const state = await connectUniview(
      deps(uniview.fetch),
      session,
      form({ clientSecret: "short", clientId: "" }),
    );
    expect(state).toMatchObject({
      status: "error",
      fieldErrors: { clientSecret: "That looks too short.", clientId: "That looks too short." },
    });
    expect(JSON.stringify(state)).not.toContain('"short"');
    expect(uniview.requests).toEqual([]);
  });

  it("is for owners only", async () => {
    const session = await newTenant("technician");
    const uniview = fakeUniview();
    expect(await connectUniview(deps(uniview.fetch), session, form())).toMatchObject({
      status: "error",
    });
    expect(await testNewUniviewCredentials(deps(uniview.fetch), session, form())).toMatchObject({
      status: "error",
    });
    expect(uniview.requests).toEqual([]);
  });
});

describe("testNewUniviewCredentials and replaceUniviewCredentials", () => {
  it("tests without saving, and audits the test", async () => {
    const session = await newTenant();
    expect(await testNewUniviewCredentials(deps(fakeUniview().fetch), session, form())).toEqual({
      status: "ok",
      message: "Connected. Kaseya UniView (Unitrends) accepted this client ID and secret.",
    });
    expect(await listIntegrationsFor({ db }, session)).toEqual([]);
    const entries = await db.withTenant(session.tenantId, ({ tx }) => tx.auditLog.findMany());
    expect(entries).toMatchObject([
      {
        action: "integration.connection_tested",
        metadata: { vendor: "kaseya_uniview", outcome: "ok" },
      },
    ]);
  });

  it("replaces the ID and secret after a passing test, and only for a UniView integration", async () => {
    const session = await newTenant();
    const created = await connectUniview(deps(fakeUniview().fetch), session, form());
    if (created.status !== "ok") throw new Error("expected ok");
    const fresh = {
      clientId: "a-new-uniview-client-wxyz",
      clientSecret: "a-new-uniview-secret-99999",
    };
    const state = await replaceUniviewCredentials(
      deps(fakeUniview(univiewFixture(), fresh).fetch),
      session,
      created.integrationId!,
      fresh,
    );
    expect(state).toEqual({
      status: "ok",
      message: "Connection details replaced. The next sync uses them.",
    });
    const [integration] = await listIntegrationsFor({ db }, session);
    expect(integration!.credentialHint).toBe("wxyz");

    const refused = await replaceUniviewCredentials(
      deps(fakeUniview().fetch),
      session,
      randomUUID(),
      form(),
    );
    expect(refused).toEqual({ status: "error", message: "That integration no longer exists." });
  });

  it("logs neither the secret nor the token", async () => {
    const session = await newTenant();
    logLines.length = 0;
    await connectUniview(deps(fakeUniview().fetch), session, form());
    expect(logLines.join("\n")).not.toContain(FIXTURE_CLIENT_SECRET);
  });
});
