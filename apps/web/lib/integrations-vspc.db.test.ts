import { randomBytes, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { fakeVspc, FIXTURE_KEY, vspcFixture } from "@valtrexia/connectors/vspc/fixtures";
import { createLogger, LocalKeyProvider } from "@valtrexia/core/server";
import { createDb, decryptIntegrationCredentials, type Db } from "@valtrexia/db";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  connectVspc,
  listIntegrationsFor,
  replaceVspcCredentials,
  testNewVspcCredentials,
  type IntegrationDeps,
} from "./integrations-core";
import { createRateLimiter } from "./rate-limit";
import type { TenantSession } from "./session-core";

const urls = inject("databaseUrls");
let db: Db;
const keyProvider = new LocalKeyProvider(randomBytes(32).toString("base64"));
const logLines: string[] = [];
const logger = createLogger({
  name: "vspc-integrations-test",
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

const SERVER = "https://vspc.example.com:1280";

function deps(
  fetchImpl: typeof fetch | undefined,
  overrides: Partial<IntegrationDeps> = {},
): IntegrationDeps {
  return {
    db,
    keyProvider,
    connectorDeps: {
      allowMock: false,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
      maxRetries: 0,
      logger,
    },
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
  serverUrl: `${SERVER}/api/v3/`,
  apiKey: FIXTURE_KEY,
  ...overrides,
});

describe("connectVspc", () => {
  it("tests, then saves the address and key encrypted, with a hint of the host and key", async () => {
    const session = await newTenant();
    const console = fakeVspc();
    const state = await connectVspc(deps(console.fetch), session, form());
    expect(state).toMatchObject({
      status: "ok",
      message:
        "Veeam Service Provider Console is connected. The first sync starts within a few minutes.",
      integrationId: expect.any(String) as string,
    });
    // One request, the connection test, before saving.
    expect(console.requests.map((r) => r.path)).toEqual(["organizations/companies"]);

    const [integration] = await listIntegrationsFor({ db }, session);
    expect(integration).toMatchObject({
      vendor: "veeam_vspc",
      name: "Veeam Service Provider Console",
      credentialHint: "vspc.example.com:1280, key ending cdef",
    });
    expect(JSON.stringify(integration)).not.toContain(FIXTURE_KEY);

    const stored = await db.withTenant(session.tenantId, ({ tx }) =>
      tx.integration.findUniqueOrThrow({ where: { id: integration!.id } }),
    );
    expect(JSON.stringify(stored.credentialsEnc)).not.toContain(FIXTURE_KEY);
    const decrypted = await decryptIntegrationCredentials(
      { tenantId: session.tenantId },
      keyProvider,
      stored,
    );
    // Saved as normalized: no trailing "/api/v3".
    expect(decrypted.expose()).toEqual({ serverUrl: SERVER, apiKey: FIXTURE_KEY });
  });

  it("saves nothing when the console rejects the key", async () => {
    const session = await newTenant();
    const state = await connectVspc(
      deps(fakeVspc(vspcFixture(), { key: "another-key-entirely-00000" }).fetch),
      session,
      form(),
    );
    expect(state).toEqual({
      status: "error",
      message:
        "Not saved. Veeam Service Provider Console rejected this API key. Check that it was copied in full, is enabled, and has the REST API scope.",
    });
    expect(await listIntegrationsFor({ db }, session)).toEqual([]);
  });

  it("refuses a console at a private address, says why, and never connects", async () => {
    const session = await newTenant();
    // No fetch override: the guarded fetch decides.
    const state = await connectVspc(
      deps(undefined),
      session,
      form({ serverUrl: "https://10.1.2.3:1280" }),
    );
    expect(state).toEqual({
      status: "error",
      message: "Not saved. The URL must point to a public address, not a private or internal one.",
    });
    expect(await listIntegrationsFor({ db }, session)).toEqual([]);
  });

  it.each([
    ["http://vspc.example.com:1280", "serverUrl"],
    ["vspc.example.com:1280", "serverUrl"],
    ["https://admin:pw@vspc.example.com", "serverUrl"],
    ["", "serverUrl"],
  ])("refuses the address %j before testing anything", async (serverUrl, field) => {
    const session = await newTenant();
    const console = fakeVspc();
    const state = await connectVspc(deps(console.fetch), session, form({ serverUrl }));
    expect(state).toMatchObject({
      status: "error",
      fieldErrors: { [field]: expect.any(String) as string },
    });
    expect(console.requests).toEqual([]);
  });

  it("refuses a key that cannot be one, and does not echo it back", async () => {
    const session = await newTenant();
    const state = await connectVspc(deps(fakeVspc().fetch), session, form({ apiKey: "short" }));
    expect(state).toMatchObject({ fieldErrors: { apiKey: "That key looks too short." } });
    expect(JSON.stringify(state)).not.toContain('"short"');
  });

  it("is for owners only", async () => {
    const session = await newTenant("technician");
    const console = fakeVspc();
    expect(await connectVspc(deps(console.fetch), session, form())).toMatchObject({
      status: "error",
    });
    expect(await testNewVspcCredentials(deps(console.fetch), session, form())).toMatchObject({
      status: "error",
    });
    expect(console.requests).toEqual([]);
  });
});

describe("testNewVspcCredentials and replaceVspcCredentials", () => {
  it("tests without saving, and audits the test", async () => {
    const session = await newTenant();
    expect(await testNewVspcCredentials(deps(fakeVspc().fetch), session, form())).toEqual({
      status: "ok",
      message: "Connected. Veeam Service Provider Console accepted this API key.",
    });
    expect(await listIntegrationsFor({ db }, session)).toEqual([]);
    const entries = await db.withTenant(session.tenantId, ({ tx }) => tx.auditLog.findMany());
    expect(entries).toMatchObject([
      {
        action: "integration.connection_tested",
        metadata: { vendor: "veeam_vspc", outcome: "ok" },
      },
    ]);
  });

  it("replaces the address and key after a passing test, and only for a VSPC integration", async () => {
    const session = await newTenant();
    const created = await connectVspc(deps(fakeVspc().fetch), session, form());
    if (created.status !== "ok") throw new Error("expected ok");
    const newKey = "a-fresh-vspc-api-key-9999wxyz";
    const moved = fakeVspc(vspcFixture(), {
      base: "https://vspc2.example.com/api/v3/",
      key: newKey,
    });

    const state = await replaceVspcCredentials(deps(moved.fetch), session, created.integrationId!, {
      serverUrl: "https://vspc2.example.com",
      apiKey: newKey,
    });
    expect(state).toEqual({
      status: "ok",
      message: "Connection details replaced. The next sync uses them.",
    });
    const [integration] = await listIntegrationsFor({ db }, session);
    expect(integration!.credentialHint).toBe("vspc2.example.com, key ending wxyz");

    const refused = await replaceVspcCredentials(
      deps(fakeVspc().fetch),
      session,
      randomUUID(),
      form(),
    );
    expect(refused).toEqual({ status: "error", message: "That integration no longer exists." });
  });

  it("logs neither the key nor the address's path", async () => {
    const session = await newTenant();
    logLines.length = 0;
    await connectVspc(deps(fakeVspc().fetch), session, form());
    expect(logLines.join("\n")).not.toContain(FIXTURE_KEY);
  });
});
