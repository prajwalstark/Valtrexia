import { randomBytes, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { createLogger, LocalKeyProvider, Secret } from "@valtrexia/core/server";
import { createDb, createIntegration, type Db } from "@valtrexia/db";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import {
  connectDatto,
  disconnectIntegration,
  getIntegrationFor,
  listIntegrationsFor,
  replaceDattoCredentials,
  testNewDattoCredentials,
  testSavedIntegration,
  type ActionState,
  type IntegrationDeps,
} from "./integrations-core";
import { createRateLimiter } from "./rate-limit";
import type { TenantSession } from "./session-core";

const urls = inject("databaseUrls");
let db: Db;
const keyProvider = new LocalKeyProvider(randomBytes(32).toString("base64"));

// Obviously fake. Fixtures must never look like real keys.
const PUBLIC = "fixture-public-9f3a";
const SECRET = "fixture-secret-do-not-use";
const basic = (publicKey: string, secretKey: string) =>
  `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`;

const logLines: string[] = [];
const logger = createLogger({
  name: "integrations-test",
  level: "debug",
  destination: new Writable({
    write(chunk: Buffer, _encoding, done) {
      logLines.push(chunk.toString());
      done();
    },
  }),
});

/** A stand-in for Datto: accepts one key pair, rejects every other. */
function datto(
  accept: { publicKey: string; secretKey: string } | "outage" | "limited" = {
    publicKey: PUBLIC,
    secretKey: SECRET,
  },
) {
  const seen: { url: string; authorization: string | undefined; method: string | undefined }[] = [];
  const impl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const authorization = (init?.headers as Record<string, string> | undefined)?.authorization;
    seen.push({ url: String(input), authorization, method: init?.method });
    if (accept === "outage") throw new TypeError("fetch failed");
    if (accept === "limited")
      return new Response("", { status: 429, headers: { "retry-after": "900" } });
    return authorization === basic(accept.publicKey, accept.secretKey)
      ? new Response(JSON.stringify({ items: [] }), { status: 200 })
      : new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  return { impl, seen };
}

function deps(fetchImpl: typeof fetch, overrides: Partial<IntegrationDeps> = {}): IntegrationDeps {
  return {
    db,
    keyProvider,
    connectorDeps: { allowMock: true, fetch: fetchImpl, maxRetries: 0, logger },
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
      data: { tenantId, clerkUserId: `user_${randomUUID()}`, email: "o@msp.example", role },
    }),
  );
  return { tenantId, userId: user.id, clerkUserId: user.clerkUserId, role };
}

const form = (overrides: Record<string, unknown> = {}) => ({
  name: "",
  publicKey: PUBLIC,
  secretKey: SECRET,
  ...overrides,
});

const rawRow = (session: TenantSession, id: string) =>
  db.withTenant(session.tenantId, ({ tx }) => tx.integration.findUnique({ where: { id } }));
const audit = (session: TenantSession) =>
  db.withTenant(session.tenantId, ({ tx }) =>
    tx.auditLog.findMany({ orderBy: { createdAt: "asc" } }),
  );

function idOf(state: ActionState): string {
  if (state.status !== "ok" || !state.integrationId)
    throw new Error(`expected a saved integration, got ${JSON.stringify(state)}`);
  return state.integrationId;
}

/** Nothing derived from the keys may appear in `value`. */
function expectNoSecrets(value: unknown, extra: string[] = []) {
  const text = JSON.stringify(value);
  for (const secret of [SECRET, PUBLIC, basic(PUBLIC, SECRET).slice(6), ...extra]) {
    expect(text, `must not contain ${secret}`).not.toContain(secret);
  }
}

beforeAll(() => {
  db = createDb({ url: urls.app });
});
afterAll(async () => {
  await db.disconnect();
});
beforeEach(() => {
  logLines.length = 0;
});

describe("connectDatto", () => {
  it("tests the keys with Datto, then stores them encrypted", async () => {
    const session = await newTenant();
    const api = datto();
    const state = await connectDatto(deps(api.impl), session, form());

    expect(state).toMatchObject({ status: "ok" });
    expect(api.seen).toEqual([
      {
        url: "https://api.datto.com/v1/bcdr/device?_page=1&_perPage=1",
        authorization: basic(PUBLIC, SECRET),
        method: "GET",
      },
    ]);

    const row = (await rawRow(session, idOf(state)))!;
    expect(row).toMatchObject({
      vendor: "datto_bcdr",
      name: "Datto BCDR",
      credentialHint: "9f3a",
      syncStatus: "never",
      lastSyncAt: null,
    });
    expect(row.credentialsEnc).toMatchObject({ v: 1, alg: "AES-256-GCM" });
    expectNoSecrets(row);
  });

  it("what is stored decrypts back to the keys, for this tenant and integration only", async () => {
    const session = await newTenant();
    const state = await connectDatto(deps(datto().impl), session, form());
    const id = idOf(state);

    // Prove it by using them: the saved-credentials test must send the same header.
    const api = datto();
    await testSavedIntegration(deps(api.impl), session, id);
    expect(api.seen[0]!.authorization).toBe(basic(PUBLIC, SECRET));
  });

  it("returns nothing derived from the keys", async () => {
    const session = await newTenant();
    const state = await connectDatto(deps(datto().impl), session, form());
    expect(Object.keys(state).sort()).toEqual(["integrationId", "message", "status"]);
    expectNoSecrets(state);
  });

  it("uses the label when one is given, trimmed", async () => {
    const session = await newTenant();
    const state = await connectDatto(
      deps(datto().impl),
      session,
      form({ name: "  Datto (EU partner)  " }),
    );
    expect((await rawRow(session, idOf(state)))!.name).toBe("Datto (EU partner)");
  });

  it("does not save keys that Datto rejects", async () => {
    const session = await newTenant();
    const state = await connectDatto(
      deps(datto().impl),
      session,
      form({ secretKey: "fixture-wrong-secret" }),
    );

    expect(state.status).toBe("error");
    expect(state).toMatchObject({
      message: expect.stringMatching(/^Not saved\. Datto BCDR rejected these keys/),
    });
    expect(await listIntegrationsFor({ db }, session)).toEqual([]);
    expectNoSecrets(state, ["fixture-wrong-secret"]);
  });

  it("does not save when Datto cannot be reached or is rate limiting", async () => {
    const session = await newTenant();
    const down = await connectDatto(deps(datto("outage").impl), session, form());
    const limited = await connectDatto(deps(datto("limited").impl), session, form());
    expect(down).toMatchObject({
      status: "error",
      message: expect.stringContaining("could not be reached"),
    });
    expect(limited).toMatchObject({
      status: "error",
      message: expect.stringContaining("limiting requests"),
    });
    expect(await listIntegrationsFor({ db }, session)).toEqual([]);
  });

  it("reports invalid input per field, without contacting Datto or echoing the input", async () => {
    const session = await newTenant();
    const api = datto();
    const state = await connectDatto(
      deps(api.impl),
      session,
      form({ publicKey: "has a space fixture-typed-public", secretKey: "", name: "x".repeat(61) }),
    );
    expect(state.status).toBe("error");
    if (state.status !== "error") return;
    expect(Object.keys(state.fieldErrors ?? {}).sort()).toEqual(["name", "publicKey", "secretKey"]);
    expect(api.seen).toEqual([]);
    expect(JSON.stringify(state)).not.toContain("fixture-typed-public");
  });

  it.each([null, undefined, "a string", 42, [], { publicKey: 1, secretKey: {} }])(
    "survives malformed input %o",
    async (input) => {
      const session = await newTenant();
      const state = await connectDatto(deps(datto().impl), session, input);
      expect(state.status).toBe("error");
    },
  );

  it("ignores extra fields, so a caller cannot redirect the request or pick a tenant", async () => {
    const session = await newTenant();
    const other = await newTenant();
    const api = datto();
    const state = await connectDatto(
      deps(api.impl),
      session,
      form({ baseUrl: "https://evil.example.test", tenantId: other.tenantId, vendor: "mock" }),
    );
    expect(api.seen[0]!.url).toMatch(/^https:\/\/api\.datto\.com\//);
    expect(await rawRow(session, idOf(state))).toMatchObject({ vendor: "datto_bcdr" });
    expect(await listIntegrationsFor({ db }, other)).toEqual([]);
  });

  it("refuses a second integration with the same name, and allows a differently named one", async () => {
    const session = await newTenant();
    await connectDatto(deps(datto().impl), session, form());
    const api = datto();
    const duplicate = await connectDatto(deps(api.impl), session, form());
    expect(duplicate).toMatchObject({ status: "error", fieldErrors: { name: expect.any(String) } });
    expect(api.seen).toEqual([]); // not even tested

    const second = await connectDatto(
      deps(datto().impl),
      session,
      form({ name: "Datto (second account)" }),
    );
    expect(second.status).toBe("ok");
    expect(await listIntegrationsFor({ db }, session)).toHaveLength(2);
  });

  it("the same name is free in another tenant", async () => {
    const one = await newTenant();
    const two = await newTenant();
    expect((await connectDatto(deps(datto().impl), one, form())).status).toBe("ok");
    expect((await connectDatto(deps(datto().impl), two, form())).status).toBe("ok");
  });

  it("is refused for technicians, before anything else happens", async () => {
    const session = await newTenant("technician");
    const api = datto();
    const state = await connectDatto(deps(api.impl), session, form());
    expect(state).toEqual({
      status: "error",
      message: "Only workspace owners can manage integrations.",
    });
    expect(api.seen).toEqual([]);
    expect(await listIntegrationsFor({ db }, session)).toEqual([]);
  });

  it("writes an audit trail that names who and what, and nothing secret", async () => {
    const session = await newTenant();
    const state = await connectDatto(deps(datto().impl), session, form());
    const entries = await audit(session);

    expect(entries.map((e) => e.action)).toEqual([
      "integration.connection_tested",
      "integration.created",
    ]);
    expect(entries[0]).toMatchObject({
      actorUserId: session.userId,
      ip: "203.0.113.9",
      metadata: { vendor: "datto_bcdr", outcome: "ok" },
    });
    expect(entries[1]).toMatchObject({
      actorUserId: session.userId,
      targetId: idOf(state),
      metadata: { vendor: "datto_bcdr", name: "Datto BCDR" },
    });
    expectNoSecrets(entries);
  });

  it("audits a rejected attempt too", async () => {
    const session = await newTenant();
    await connectDatto(deps(datto().impl), session, form({ secretKey: "fixture-wrong-secret" }));
    expect(await audit(session)).toMatchObject([
      { action: "integration.connection_tested", metadata: { outcome: "rejected" } },
    ]);
  });
});

describe("testNewDattoCredentials", () => {
  it("reports accepted keys without saving anything", async () => {
    const session = await newTenant();
    const state = await testNewDattoCredentials(deps(datto().impl), session, form());
    expect(state).toEqual({ status: "ok", message: "Connected. Datto BCDR accepted these keys." });
    expect(await listIntegrationsFor({ db }, session)).toEqual([]);
  });

  it("reports rejected keys in plain words", async () => {
    const session = await newTenant();
    const state = await testNewDattoCredentials(
      deps(datto().impl),
      session,
      form({ publicKey: "fixture-other-public" }),
    );
    expect(state).toMatchObject({
      status: "error",
      message: expect.stringContaining("rejected these keys"),
    });
    expectNoSecrets(state, ["fixture-other-public"]);
  });

  it("is refused for technicians", async () => {
    const api = datto();
    const state = await testNewDattoCredentials(
      deps(api.impl),
      await newTenant("technician"),
      form(),
    );
    expect(state.status).toBe("error");
    expect(api.seen).toEqual([]);
  });

  it("is rate limited per tenant, so it cannot be used to try keys at speed", async () => {
    const session = await newTenant();
    const other = await newTenant();
    const api = datto();
    const limited = deps(api.impl, { limiter: createRateLimiter({ limit: 3, windowMs: 60_000 }) });

    for (let i = 0; i < 3; i += 1)
      await testNewDattoCredentials(limited, session, form({ secretKey: `fixture-guess-${i}` }));
    const fourth = await testNewDattoCredentials(limited, session, form());
    expect(fourth).toEqual({
      status: "error",
      message: "Too many connection tests. Wait a minute and try again.",
    });
    expect(api.seen).toHaveLength(3);

    // Another tenant has its own allowance.
    expect((await testNewDattoCredentials(limited, other, form())).status).toBe("ok");
  });
});

describe("testSavedIntegration", () => {
  it("decrypts the stored keys on the server and tests them", async () => {
    const session = await newTenant();
    const id = idOf(await connectDatto(deps(datto().impl), session, form()));
    const api = datto();
    const state = await testSavedIntegration(deps(api.impl), session, id);

    expect(state).toEqual({ status: "ok", message: "Connected. Datto BCDR accepted these keys." });
    expect(api.seen).toHaveLength(1);
    expectNoSecrets(state);
    expect((await audit(session)).at(-1)).toMatchObject({
      action: "integration.connection_tested",
      targetId: id,
      metadata: { outcome: "ok" },
    });
  });

  it("reports keys that Datto has since revoked", async () => {
    const session = await newTenant();
    const id = idOf(await connectDatto(deps(datto().impl), session, form()));
    const revoked = datto({ publicKey: "fixture-rotated", secretKey: "fixture-rotated" });
    const state = await testSavedIntegration(deps(revoked.impl), session, id);
    expect(state).toMatchObject({
      status: "error",
      message: expect.stringContaining("rejected these keys"),
    });
  });

  it("cannot test another tenant's integration", async () => {
    const mine = await newTenant();
    const theirs = await newTenant();
    const theirId = idOf(await connectDatto(deps(datto().impl), theirs, form()));
    const api = datto();
    const state = await testSavedIntegration(deps(api.impl), mine, theirId);
    expect(state).toEqual({ status: "error", message: "That integration no longer exists." });
    expect(api.seen).toEqual([]); // their keys were never decrypted or sent
  });

  it("treats a malformed id as not found", async () => {
    const session = await newTenant();
    for (const id of ["", "not-a-uuid", "' OR 1=1 --"]) {
      expect(await testSavedIntegration(deps(datto().impl), session, id)).toEqual({
        status: "error",
        message: "That integration no longer exists.",
      });
    }
  });

  it("is refused for technicians", async () => {
    const owner = await newTenant();
    const id = idOf(await connectDatto(deps(datto().impl), owner, form()));
    const technician: TenantSession = { ...owner, role: "technician" };
    const api = datto();
    expect((await testSavedIntegration(deps(api.impl), technician, id)).status).toBe("error");
    expect(api.seen).toEqual([]);
  });

  it("says so when the stored keys cannot be read", async () => {
    const session = await newTenant();
    const id = idOf(await connectDatto(deps(datto().impl), session, form()));
    const wrongKey = new LocalKeyProvider(randomBytes(32).toString("base64"));
    const state = await testSavedIntegration(
      deps(datto().impl, { keyProvider: wrongKey }),
      session,
      id,
    );
    expect(state).toEqual({
      status: "error",
      message: "The saved keys could not be read. Replace them with a new key pair.",
    });
  });

  it("works for the demo vendor as well", async () => {
    const session = await newTenant();
    const integration = await db.withTenant(session.tenantId, (context) =>
      createIntegration(context, keyProvider, {
        vendor: "mock",
        name: "Demo data",
        credentials: new Secret({ seed: "demo" }),
        actorUserId: session.userId,
      }),
    );
    expect(await testSavedIntegration(deps(datto().impl), session, integration.id)).toEqual({
      status: "ok",
      message: "Connected. Demo data accepted these keys.",
    });
  });
});

describe("replaceDattoCredentials", () => {
  const NEW = { publicKey: "fixture-new-public-77b2", secretKey: "fixture-new-secret" };

  it("tests the new keys, re-encrypts, and makes the integration due for a sync", async () => {
    const session = await newTenant();
    const id = idOf(await connectDatto(deps(datto().impl), session, form()));
    await db.withTenant(session.tenantId, ({ tx }) =>
      tx.integration.update({
        where: { id },
        data: {
          syncStatus: "error",
          lastSyncError: "The vendor rejected these credentials.",
          lastSyncStartedAt: new Date(),
        },
      }),
    );
    const before = (await rawRow(session, id))!;

    const state = await replaceDattoCredentials(deps(datto(NEW).impl), session, id, NEW);
    expect(state).toEqual({
      status: "ok",
      message: "Keys replaced. The next sync uses the new key pair.",
    });

    const after = (await rawRow(session, id))!;
    expect(after).toMatchObject({
      credentialHint: "77b2",
      syncStatus: "never",
      lastSyncError: null,
      lastSyncStartedAt: null,
    });
    expect(after.credentialsEnc).not.toEqual(before.credentialsEnc);
    expectNoSecrets(after, [NEW.publicKey, NEW.secretKey]);

    // The old keys are gone: the saved test now sends the new pair.
    const api = datto(NEW);
    await testSavedIntegration(deps(api.impl), session, id);
    expect(api.seen[0]!.authorization).toBe(basic(NEW.publicKey, NEW.secretKey));
    expect(
      (await db.listDueIntegrations({ intervalMinutes: 15 })).map((d) => d.integrationId),
    ).toContain(id);
  });

  it("keeps the old keys when the new ones are rejected", async () => {
    const session = await newTenant();
    const id = idOf(await connectDatto(deps(datto().impl), session, form()));
    const before = (await rawRow(session, id))!;

    const state = await replaceDattoCredentials(deps(datto().impl), session, id, NEW);
    expect(state).toMatchObject({
      status: "error",
      message: expect.stringMatching(/^Not saved\./),
    });
    expect((await rawRow(session, id))!.credentialsEnc).toEqual(before.credentialsEnc);
  });

  it("cannot replace another tenant's keys", async () => {
    const mine = await newTenant();
    const theirs = await newTenant();
    const theirId = idOf(await connectDatto(deps(datto().impl), theirs, form()));
    const before = (await rawRow(theirs, theirId))!;
    const api = datto(NEW);

    const state = await replaceDattoCredentials(deps(api.impl), mine, theirId, NEW);
    expect(state).toEqual({ status: "error", message: "That integration no longer exists." });
    expect(api.seen).toEqual([]);
    expect((await rawRow(theirs, theirId))!.credentialsEnc).toEqual(before.credentialsEnc);
  });

  it("is refused for technicians, and audited for owners", async () => {
    const owner = await newTenant();
    const id = idOf(await connectDatto(deps(datto().impl), owner, form()));
    expect(
      (
        await replaceDattoCredentials(
          deps(datto(NEW).impl),
          { ...owner, role: "technician" },
          id,
          NEW,
        )
      ).status,
    ).toBe("error");

    await replaceDattoCredentials(deps(datto(NEW).impl), owner, id, NEW);
    const entries = await audit(owner);
    expect(entries.at(-1)).toMatchObject({
      action: "integration.credentials_replaced",
      targetId: id,
      actorUserId: owner.userId,
    });
    expectNoSecrets(entries, [NEW.publicKey, NEW.secretKey]);
  });

  it("only applies to Datto integrations", async () => {
    const session = await newTenant();
    const demo = await db.withTenant(session.tenantId, (context) =>
      createIntegration(context, keyProvider, {
        vendor: "mock",
        name: "Demo data",
        credentials: new Secret({ seed: "demo" }),
        actorUserId: null,
      }),
    );
    const state = await replaceDattoCredentials(deps(datto(NEW).impl), session, demo.id, NEW);
    expect(state.status).toBe("error");
  });
});

describe("disconnectIntegration", () => {
  it("needs the integration's name typed exactly", async () => {
    const session = await newTenant();
    const id = idOf(await connectDatto(deps(datto().impl), session, form()));
    for (const typed of ["", "datto bcdr", "Datto", undefined, 42]) {
      const state = await disconnectIntegration(deps(datto().impl), session, id, typed);
      expect(state).toMatchObject({
        status: "error",
        fieldErrors: { confirm: expect.any(String) },
      });
    }
    expect(await rawRow(session, id)).not.toBeNull();
  });

  it("removes the integration and what came from it, keeps clients, and audits it", async () => {
    const session = await newTenant();
    const id = idOf(await connectDatto(deps(datto().impl), session, form()));
    await db.withTenant(session.tenantId, async ({ tx, tenantId }) => {
      const client = await tx.client.create({ data: { tenantId, name: "Harborview Dental" } });
      const asset = await tx.asset.create({
        data: {
          tenantId,
          clientId: client.id,
          integrationId: id,
          vendorAssetId: "a1",
          name: "DC01",
          type: "agent",
        },
      });
      await tx.backupResult.create({
        data: {
          tenantId,
          assetId: asset.id,
          integrationId: id,
          vendorResultId: "r1",
          startedAt: new Date(),
          status: "success",
          vendorStatusRaw: "ok",
          rawPayload: {},
        },
      });
    });

    const state = await disconnectIntegration(deps(datto().impl), session, id, " Datto BCDR ");
    expect(state).toEqual({
      status: "ok",
      message: "Datto BCDR was disconnected and 1 assets were removed.",
    });

    const left = await db.withTenant(session.tenantId, async ({ tx }) => ({
      integrations: await tx.integration.count(),
      assets: await tx.asset.count(),
      results: await tx.backupResult.count(),
      clients: await tx.client.count(),
    }));
    expect(left).toEqual({ integrations: 0, assets: 0, results: 0, clients: 1 });
    expect((await audit(session)).at(-1)).toMatchObject({
      action: "integration.deleted",
      targetId: id,
      actorUserId: session.userId,
      metadata: { vendor: "datto_bcdr", name: "Datto BCDR", assetsRemoved: 1 },
    });
  });

  it("cannot disconnect another tenant's integration, even with the right name", async () => {
    const mine = await newTenant();
    const theirs = await newTenant();
    const theirId = idOf(await connectDatto(deps(datto().impl), theirs, form()));
    const state = await disconnectIntegration(deps(datto().impl), mine, theirId, "Datto BCDR");
    expect(state).toEqual({ status: "error", message: "That integration no longer exists." });
    expect(await rawRow(theirs, theirId)).not.toBeNull();
  });

  it("is refused for technicians", async () => {
    const owner = await newTenant();
    const id = idOf(await connectDatto(deps(datto().impl), owner, form()));
    const state = await disconnectIntegration(
      deps(datto().impl),
      { ...owner, role: "technician" },
      id,
      "Datto BCDR",
    );
    expect(state.status).toBe("error");
    expect(await rawRow(owner, id)).not.toBeNull();
  });
});

describe("what the interface is given", () => {
  it("lists integrations with a hint and status, and never the credentials", async () => {
    const session = await newTenant();
    const id = idOf(await connectDatto(deps(datto().impl), session, form()));
    const listed = await listIntegrationsFor({ db }, session);

    expect(listed).toHaveLength(1);
    expect(Object.keys(listed[0]!).sort()).toEqual(
      [
        "createdAt",
        "credentialHint",
        "id",
        "lastSyncAt",
        "lastSyncError",
        "lastSyncStartedAt",
        "name",
        "syncStatus",
        "vendor",
      ].sort(),
    );
    expect(listed[0]).toMatchObject({ id, credentialHint: "9f3a" });
    expectNoSecrets(listed);
    expect(JSON.stringify(listed)).not.toContain("ciphertext");
    expect(JSON.stringify(listed)).not.toContain("wrappedKey");

    const one = await getIntegrationFor({ db }, session, id);
    expect(one).toEqual(listed[0]);
  });

  it("shows technicians the same safe summary", async () => {
    const owner = await newTenant();
    await connectDatto(deps(datto().impl), owner, form());
    const listed = await listIntegrationsFor({ db }, { ...owner, role: "technician" });
    expect(listed).toHaveLength(1);
    expectNoSecrets(listed);
  });

  it("does not show one tenant another's integrations", async () => {
    const mine = await newTenant();
    const theirs = await newTenant();
    const theirId = idOf(await connectDatto(deps(datto().impl), theirs, form()));
    expect(await listIntegrationsFor({ db }, mine)).toEqual([]);
    expect(await getIntegrationFor({ db }, mine, theirId)).toBeNull();
    expect(await getIntegrationFor({ db }, mine, "not-a-uuid")).toBeNull();
  });
});

describe("logs", () => {
  it("contain nothing derived from the keys across every operation", async () => {
    const session = await newTenant();
    logLines.length = 0;
    const id = idOf(await connectDatto(deps(datto().impl), session, form()));
    await testSavedIntegration(deps(datto().impl), session, id);
    await testSavedIntegration(deps(datto("outage").impl), session, id);
    await connectDatto(
      deps(datto().impl),
      session,
      form({ name: "Second", secretKey: "fixture-wrong-secret" }),
    );
    await replaceDattoCredentials(deps(datto().impl), session, id, {
      publicKey: "fixture-new-public-77b2",
      secretKey: "fixture-new-secret",
    });
    await testSavedIntegration(
      deps(datto().impl, { keyProvider: new LocalKeyProvider(randomBytes(32).toString("base64")) }),
      session,
      id,
    );

    const output = logLines.join("");
    expect(output.length).toBeGreaterThan(0);
    for (const secret of [
      SECRET,
      PUBLIC,
      basic(PUBLIC, SECRET).slice(6),
      "fixture-wrong-secret",
      "fixture-new-secret",
      "fixture-new-public-77b2",
    ]) {
      expect(output, `logs must not contain ${secret}`).not.toContain(secret);
    }
  });
});
