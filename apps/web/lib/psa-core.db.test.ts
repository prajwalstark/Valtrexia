import { randomBytes, randomUUID } from "node:crypto";
import { LocalKeyProvider } from "@valtrexia/core/server";
import {
  FAKE_SYNCRO_BASE,
  FAKE_SYNCRO_TOKEN,
  fakeSyncro,
  type FakeSyncro,
} from "@valtrexia/core/testing/fake-syncro";
import { createDb, decryptPsaCredentials, type Db } from "@valtrexia/db";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  createSyncroChannelFor,
  getSyncroSetup,
  readSubdomain,
  replaceSyncroTokenFor,
  saveSyncroMappingsFor,
  saveSyncroSettingsFor,
} from "./psa-core";
import type { TenantSession } from "./session-core";

const urls = inject("databaseUrls");
let db: Db;
const keyProvider = new LocalKeyProvider(randomBytes(32).toString("base64"));
beforeAll(() => {
  db = createDb({ url: urls.app });
});
afterAll(async () => {
  await db.disconnect();
});

/** A workspace with an owner, a technician, and clients named like two of the stand-in's customers. */
async function workspace() {
  const tenantId = await db.provisionTenant({ clerkOrgId: `org_${randomUUID()}`, name: "MSP" });
  return db.withTenant(tenantId, async ({ tx }) => {
    const user = async (role: "owner" | "technician"): Promise<TenantSession> => {
      const row = await tx.user.create({
        data: { tenantId, clerkUserId: `user_${randomUUID()}`, email: `${role}@msp.example`, role },
      });
      return { tenantId, userId: row.id, clerkUserId: row.clerkUserId, role };
    };
    const acme = await tx.client.create({ data: { tenantId, name: "ACME dental" } });
    const other = await tx.client.create({ data: { tenantId, name: "Zeta Corp" } });
    return { tenantId, owner: await user("owner"), tech: await user("technician"), acme, other };
  });
}

const deps = (fake: FakeSyncro) => ({
  db,
  keyProvider,
  ip: "203.0.113.7",
  psa: { fetch: fake.fetch, baseUrl: FAKE_SYNCRO_BASE },
});
const input = {
  name: "Syncro",
  subdomain: "https://Northwind.syncromsp.com/tickets",
  apiToken: FAKE_SYNCRO_TOKEN,
  incidentTypes: ["failed", "missed", "stale"],
};

describe("readSubdomain", () => {
  it("takes the name, the address or a link, and nothing else", () => {
    expect(readSubdomain("northwind")).toBe("northwind");
    expect(readSubdomain(" Northwind.syncromsp.com ")).toBe("northwind");
    expect(readSubdomain("https://northwind.syncromsp.com/customers/1")).toBe("northwind");
    for (const bad of [
      "",
      "evil.com",
      "https://evil.com",
      "north wind",
      "a.b.syncromsp.com",
      null,
      3,
    ]) {
      expect(readSubdomain(bad), String(bad)).toBeNull();
    }
  });
});

describe("Syncro channels", () => {
  it("connects only after Syncro accepts the token, stores it encrypted, and never returns it", async () => {
    const w = await workspace();
    const fake = fakeSyncro();
    const state = await createSyncroChannelFor(deps(fake), w.owner, input);
    expect(state).toMatchObject({ status: "ok", channelId: expect.any(String) });
    expect(JSON.stringify(state)).not.toContain(FAKE_SYNCRO_TOKEN);
    const channel = await db.withTenant(w.tenantId, ({ tx }) =>
      tx.notificationChannel.findUniqueOrThrow({
        where: { id: (state as { channelId: string }).channelId },
      }),
    );
    expect(channel).toMatchObject({
      type: "psa",
      notifyIntegrationHealth: false,
      notifyMonthlyReport: false,
      config: {
        provider: "syncro",
        subdomain: "northwind",
        problemType: null,
        resolvedStatus: "Resolved",
      },
    });
    expect(JSON.stringify(channel.config)).not.toContain(FAKE_SYNCRO_TOKEN);
    expect(JSON.stringify(channel.secretEnc)).not.toContain(FAKE_SYNCRO_TOKEN);
    const decrypted = await decryptPsaCredentials({ tenantId: w.tenantId }, keyProvider, channel);
    expect(decrypted.expose()).toEqual({ subdomain: "northwind", apiToken: FAKE_SYNCRO_TOKEN });
    const audit = await db.withTenant(w.tenantId, ({ tx }) =>
      tx.auditLog.findFirstOrThrow({ where: { action: "notification_channel.created" } }),
    );
    expect(JSON.stringify(audit)).not.toContain(FAKE_SYNCRO_TOKEN);
  });

  it("names the field at fault, and saves nothing, when Syncro refuses", async () => {
    const w = await workspace();
    expect(
      await createSyncroChannelFor(deps(fakeSyncro()), w.owner, {
        ...input,
        apiToken: "wrong-token-123",
      }),
    ).toMatchObject({
      status: "error",
      fieldErrors: { apiToken: "Syncro refused this API token." },
    });
    const denied = fakeSyncro();
    denied.deny.add("GET /me");
    expect(await createSyncroChannelFor(deps(denied), w.owner, input)).toMatchObject({
      fieldErrors: { apiToken: expect.stringContaining("lacks a permission") },
    });
    const unreachable = {
      ...deps(fakeSyncro()),
      psa: {
        fetch: (async () => {
          throw new TypeError("fetch failed");
        }) as typeof fetch,
        baseUrl: FAKE_SYNCRO_BASE,
      },
    };
    expect(await createSyncroChannelFor(unreachable, w.owner, input)).toMatchObject({
      fieldErrors: { subdomain: "No Syncro account answered at this address." },
    });
    expect(
      await createSyncroChannelFor(deps(fakeSyncro()), w.owner, {
        ...input,
        subdomain: "evil.com",
      }),
    ).toMatchObject({
      fieldErrors: { subdomain: expect.any(String) },
    });
    expect(await createSyncroChannelFor(deps(fakeSyncro()), w.tech, input)).toMatchObject({
      status: "error",
    });
    const count = await db.withTenant(w.tenantId, ({ tx }) => tx.notificationChannel.count());
    expect(count).toBe(0);
  });

  it("suggests customers by name, saves only customers Syncro lists, and records Syncro's names", async () => {
    const w = await workspace();
    const fake = fakeSyncro();
    const { channelId } = (await createSyncroChannelFor(deps(fake), w.owner, input)) as {
      channelId: string;
    };

    const setup = await getSyncroSetup(deps(fake), w.owner, channelId);
    if (!setup || setup === "forbidden") throw new Error("no setup");
    expect(setup.live?.customers.map((c) => c.name)).toEqual([
      "Acme Dental",
      "Jo Bloggs",
      "Customer 2",
    ]);
    expect(setup.suggestions).toEqual({ [w.acme.id]: "100" });
    expect(setup.mappings.every((m) => m.customer === null)).toBe(true);
    expect(await getSyncroSetup(deps(fake), w.tech, channelId)).toBe("forbidden");

    const invented = await saveSyncroMappingsFor(
      deps(fake),
      w.owner,
      channelId,
      new Map([[w.acme.id, "999"]]),
    );
    expect(invented).toMatchObject({ status: "error" });

    const saved = await saveSyncroMappingsFor(
      deps(fake),
      w.owner,
      channelId,
      new Map([
        [w.acme.id, "100"],
        [w.other.id, ""],
        [randomUUID(), "101"],
      ]),
    );
    expect(saved).toEqual({ status: "ok", message: "Saved: 1 client matched." });
    const after = await getSyncroSetup(deps(fake), w.owner, channelId);
    if (!after || after === "forbidden") throw new Error("no setup");
    expect(after.mappings.find((m) => m.clientId === w.acme.id)!.customer).toEqual({
      id: "100",
      name: "Acme Dental",
    });
    expect(after.suggestions).toEqual({});

    // A customer that has since gone from Syncro does not block saving the rest.
    fake.customers.splice(0, 1);
    expect(
      await saveSyncroMappingsFor(
        deps(fake),
        w.owner,
        channelId,
        new Map([
          [w.acme.id, "100"],
          [w.other.id, "101"],
        ]),
      ),
    ).toEqual({ status: "ok", message: "Saved: 1 client matched." });
  });

  it("sets the problem type and resolved status from the account's own lists", async () => {
    const w = await workspace();
    const fake = fakeSyncro();
    const { channelId } = (await createSyncroChannelFor(deps(fake), w.owner, input)) as {
      channelId: string;
    };
    expect(
      await saveSyncroSettingsFor(deps(fake), w.owner, channelId, {
        problemType: "Made up",
        resolvedStatus: "Resolved",
      }),
    ).toMatchObject({ status: "error" });
    expect(
      await saveSyncroSettingsFor(deps(fake), w.owner, channelId, {
        problemType: "Other",
        resolvedStatus: "Nope",
      }),
    ).toMatchObject({ status: "error" });
    expect(
      await saveSyncroSettingsFor(deps(fake), w.owner, channelId, {
        problemType: "Other",
        resolvedStatus: "Invoiced",
      }),
    ).toMatchObject({ status: "ok" });
    const setup = await getSyncroSetup(deps(fake), w.owner, channelId);
    expect(setup).toMatchObject({ channel: { problemType: "Other", resolvedStatus: "Invoiced" } });
  });

  it("replaces the token only with one Syncro accepts", async () => {
    const w = await workspace();
    const fake = fakeSyncro();
    const { channelId } = (await createSyncroChannelFor(deps(fake), w.owner, input)) as {
      channelId: string;
    };
    expect(
      await replaceSyncroTokenFor(deps(fake), w.owner, channelId, { apiToken: "not-accepted-1" }),
    ).toMatchObject({
      fieldErrors: { apiToken: "Syncro refused this API token." },
    });
    const rotated = fakeSyncro({ token: "NewToken-987654321" });
    expect(
      await replaceSyncroTokenFor(deps(rotated), w.owner, channelId, {
        apiToken: "NewToken-987654321",
      }),
    ).toMatchObject({
      status: "ok",
    });
    const channel = await db.withTenant(w.tenantId, ({ tx }) =>
      tx.notificationChannel.findUniqueOrThrow({ where: { id: channelId } }),
    );
    expect(
      (await decryptPsaCredentials({ tenantId: w.tenantId }, keyProvider, channel)).expose()
        .apiToken,
    ).toBe("NewToken-987654321");
  });

  it("finds nothing for another tenant's channel", async () => {
    const a = await workspace();
    const b = await workspace();
    const fake = fakeSyncro();
    const { channelId } = (await createSyncroChannelFor(deps(fake), a.owner, input)) as {
      channelId: string;
    };
    expect(await getSyncroSetup(deps(fake), b.owner, channelId)).toBeNull();
    expect(await saveSyncroMappingsFor(deps(fake), b.owner, channelId, new Map())).toMatchObject({
      status: "error",
    });
    expect(
      await replaceSyncroTokenFor(deps(fake), b.owner, channelId, { apiToken: FAKE_SYNCRO_TOKEN }),
    ).toMatchObject({
      status: "error",
    });
  });
});
