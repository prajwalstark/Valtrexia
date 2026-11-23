import { randomBytes, randomUUID } from "node:crypto";
import type { Connector, NormalizedStatus, VendorResult } from "@valtrexia/connectors";
import { brand } from "@valtrexia/core";
import { createLogger, LocalKeyProvider, Secret } from "@valtrexia/core/server";
import {
  FAKE_SYNCRO_BASE,
  FAKE_SYNCRO_TOKEN,
  fakeSyncro,
  type FakeSyncro,
} from "@valtrexia/core/testing/fake-syncro";
import {
  claimNotificationBatch,
  createIntegration,
  createPsaChannel,
  createDb,
  setPsaMappings,
  type Db,
} from "@valtrexia/db";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { syncIntegration } from "../sync/sync-integration";
import { deliverBatch, type DeliveryDeps } from "./deliver";

const urls = inject("databaseUrls");
const HOUR = 3_600_000;
const T0 = new Date("2026-11-12T12:00:00Z");
const at = (hours: number) => new Date(T0.getTime() + hours * HOUR);

let db: Db;
const keyProvider = new LocalKeyProvider(randomBytes(32).toString("base64"));
const logger = createLogger({ name: "psa-test", level: "silent" });
beforeAll(() => {
  db = createDb({ url: urls.app });
});
afterAll(async () => {
  await db.disconnect();
});

type Results = Record<string, [Date, NormalizedStatus][]>;

/**
 * Two clients: Acme Dental (FS01, SQL01) matched to Syncro customer 100, and
 * Bravo Law (FS02) not matched. FS01 and FS02 last backed up 40 hours before
 * T0, so a sync at T0 or later finds them missed; SQL01 is fine.
 */
async function setup(
  options: { token?: string; incidentTypes?: ("failed" | "missed" | "stale")[] } = {},
) {
  const tenantId = await db.provisionTenant({
    clerkOrgId: `org_${randomUUID()}`,
    name: "Northwind IT",
  });
  const integration = await db.withTenant(tenantId, (context) =>
    createIntegration(context, keyProvider, {
      vendor: "mock",
      name: "Scripted",
      credentials: new Secret({ seed: "unused" }),
      actorUserId: null,
    }),
  );
  const results: Results = {
    FS01: [[at(-40), "success"]],
    SQL01: [[at(-2), "success"]],
    FS02: [[at(-40), "success"]],
  };
  const asset = (name: string, client: string) => ({
    vendorAssetId: name,
    vendorClientId: client,
    name,
    type: "agent",
    deviceName: null,
    expectedFrequencyHours: 24,
    isPaused: false,
    isArchived: false,
  });
  const connector: Connector = {
    vendor: "mock",
    testConnection: async () => {},
    listClients: async () => [
      { vendorClientId: "c1", name: "Acme Dental" },
      { vendorClientId: "c2", name: "Bravo Law" },
    ],
    listAssets: async (clientId) =>
      [asset("FS01", "c1"), asset("SQL01", "c1"), asset("FS02", "c2")].filter(
        (a) => a.vendorClientId === clientId,
      ),
    listResults: async () =>
      Object.entries(results).flatMap(([name, list]) =>
        list.map(([when, status]): VendorResult => ({
          vendorResultId: `${name}-${when.getTime()}-${status}`,
          vendorAssetId: name,
          startedAt: when,
          endedAt: when,
          vendorStatusRaw: status,
          message: null,
          screenshotVerified: null,
          rawPayload: { status },
        })),
      ),
    normalizeStatus: (raw) => (raw as { status: NormalizedStatus }).status,
  };
  const s = {
    tenantId,
    integrationId: integration.id,
    connector,
    results,
    channelId: "",
    fake: fakeSyncro(),
  };
  await sync(s, T0);
  // The first sync opened incidents before any channel existed. Close them, so
  // the next sync opens them again with the channel there to hear.
  await db.withTenant(tenantId, ({ tx }) => tx.incident.updateMany({ data: { closedAt: T0 } }));
  const channel = await db.withTenant(tenantId, (context) =>
    createPsaChannel(context, keyProvider, {
      name: "Syncro",
      credentials: new Secret({
        subdomain: "northwind",
        apiToken: options.token ?? FAKE_SYNCRO_TOKEN,
      }),
      problemType: "Other",
      resolvedStatus: "Resolved",
      incidentTypes: options.incidentTypes ?? ["failed", "missed", "stale"],
      actorUserId: null,
    }),
  );
  s.channelId = channel.id;
  await db.withTenant(tenantId, async (context) => {
    const acme = await context.tx.client.findFirstOrThrow({ where: { name: "Acme Dental" } });
    await setPsaMappings(context, {
      channelId: channel.id,
      mappings: [{ clientId: acme.id, customer: { id: "100", name: "Acme Dental" } }],
      actorUserId: null,
    });
  });
  return s;
}
type Setup = Awaited<ReturnType<typeof setup>>;

async function sync(s: Pick<Setup, "tenantId" | "integrationId" | "connector">, now: Date) {
  await syncIntegration(
    {
      db,
      keyProvider,
      logger,
      allowMock: true,
      now: () => now,
      connectorFactory: () => s.connector,
    },
    { tenantId: s.tenantId, integrationId: s.integrationId },
  );
}

const deps = (fake: FakeSyncro, now: Date, extra: Partial<DeliveryDeps> = {}): DeliveryDeps => ({
  db,
  keyProvider,
  logger,
  outboundPolicy: {},
  emailSender: null,
  now: () => now,
  psa: { fetch: fake.fetch, baseUrl: FAKE_SYNCRO_BASE },
  ...extra,
});

/** Sends every pending message of the tenant, oldest first, as many rounds as it takes. */
async function deliverAll(s: Setup, now: Date, extra: Partial<DeliveryDeps> = {}) {
  const results = [];
  for (let round = 0; round < 5; round += 1) {
    const pending = await db.withTenant(s.tenantId, ({ tx }) =>
      tx.notificationBatch.findMany({
        where: { status: "pending", nextAttemptAt: { lte: now } },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      }),
    );
    if (pending.length === 0) break;
    for (const batch of pending) {
      results.push(
        await deliverBatch(deps(s.fake, now, extra), { tenantId: s.tenantId, batchId: batch.id }),
      );
    }
  }
  return results;
}

const tickets = (s: Setup) =>
  db.withTenant(s.tenantId, ({ tx }) =>
    tx.psaTicket.findMany({
      orderBy: { createdAt: "asc" },
      select: {
        externalTicketId: true,
        closedAt: true,
        closeReason: true,
        subject: true,
        asset: { select: { name: true } },
      },
    }),
  );

describe("PSA channels: Syncro tickets", () => {
  it("opens one ticket per asset problem, for matched clients only, with hidden comments", async () => {
    const s = await setup();
    await sync(s, at(1));
    expect(await deliverAll(s, at(1))).toEqual([expect.objectContaining({ result: "sent" })]);

    expect(s.fake.tickets).toHaveLength(1);
    const [ticket] = s.fake.tickets;
    expect(ticket!.customer_id).toBe(100);
    expect(ticket!.problem_type).toBe("Other");
    expect(ticket!.subject).toMatch(/^Backup missed: FS01 \(Acme Dental\) \[ref [0-9a-f]{10}\]$/);
    expect(ticket!.comments).toHaveLength(1);
    expect(ticket!.comments[0]).toMatchObject({
      subject: "Backup missed",
      hidden: true,
      do_not_email: true,
    });
    expect(ticket!.comments[0]!.body).toContain("Backup missed on FS01");
    // Bravo Law is not matched to a Syncro customer: nothing was queued for it.
    expect(await tickets(s)).toEqual([
      expect.objectContaining({ externalTicketId: "1", closedAt: null, asset: { name: "FS01" } }),
    ]);
    // Every request carried the token as a bearer token, and nothing else carried it.
    for (const request of s.fake.requests) {
      expect(request.headers.get("authorization")).toBe(`Bearer ${FAKE_SYNCRO_TOKEN}`);
      expect(JSON.stringify(request.body)).not.toContain(FAKE_SYNCRO_TOKEN);
      expect(request.headers.get("user-agent")).toBe(`${brand.name}-PSA/1`);
    }
  });

  it("adds a later problem to the open ticket, and resolves the ticket when the asset recovers", async () => {
    const s = await setup();
    await sync(s, at(1));
    await deliverAll(s, at(1));

    s.results.FS01!.push([at(2), "failed"]);
    await sync(s, at(3));
    await deliverAll(s, at(3));
    expect(s.fake.tickets).toHaveLength(1);
    expect(s.fake.tickets[0]!.comments.map((c) => c.subject)).toEqual([
      "Backup missed",
      "Backup failed",
    ]);

    s.results.FS01!.push([at(4), "success"]);
    await sync(s, at(5));
    await deliverAll(s, at(5));
    const ticket = s.fake.tickets[0]!;
    expect(ticket.status).toBe("Resolved");
    expect(ticket.comments.at(-1)!.subject).toBe("Backup problems resolved");
    expect(ticket.comments.at(-1)!.body).toContain("Setting this ticket to Resolved.");
    expect(ticket.comments.every((c) => c.hidden && c.do_not_email)).toBe(true);
    expect(await tickets(s)).toEqual([expect.objectContaining({ closeReason: "resolved" })]);

    // A new problem after that opens a new ticket.
    s.results.FS01!.push([at(6), "failed"]);
    await sync(s, at(7));
    await deliverAll(s, at(7));
    expect(s.fake.tickets).toHaveLength(2);
    expect(s.fake.tickets[1]!.subject).toMatch(/^Backup failed: FS01/);
  });

  it("does not open a second ticket when Syncro made one but its answer was lost", async () => {
    const s = await setup();
    await sync(s, at(1));
    s.fake.failNext({ status: 0, afterApplying: true });
    expect(await deliverAll(s, at(1))).toEqual([expect.objectContaining({ result: "retrying" })]);
    expect(s.fake.tickets).toHaveLength(1);
    const [row] = await tickets(s);
    expect(row!.externalTicketId).toBeNull();

    // The retry finds the ticket by the reference in its subject and records it.
    expect(await deliverAll(s, at(2))).toEqual([expect.objectContaining({ result: "sent" })]);
    expect(s.fake.tickets).toHaveLength(1);
    expect(s.fake.tickets[0]!.comments).toHaveLength(1);
    expect((await tickets(s))[0]!.externalTicketId).toBe("1");
  });

  it("creates the ticket on retry when the first attempt never reached Syncro", async () => {
    const s = await setup();
    await sync(s, at(1));
    s.fake.failNext({ status: 503 });
    expect(await deliverAll(s, at(1))).toEqual([expect.objectContaining({ result: "retrying" })]);
    expect(s.fake.tickets).toHaveLength(0);
    expect(await deliverAll(s, at(2))).toEqual([expect.objectContaining({ result: "sent" })]);
    expect(s.fake.tickets).toHaveLength(1);
    expect(s.fake.tickets[0]!.comments).toHaveLength(1);
  });

  it("opens a new ticket for a new problem when the last one was closed in Syncro by hand", async () => {
    const s = await setup();
    await sync(s, at(1));
    await deliverAll(s, at(1));
    s.fake.tickets[0]!.status = "Resolved";

    s.results.FS01!.push([at(2), "failed"]);
    await sync(s, at(3));
    await deliverAll(s, at(3));
    expect(s.fake.tickets).toHaveLength(2);
    expect(s.fake.tickets[0]!.comments).toHaveLength(1);
    expect((await tickets(s)).map((t) => t.closeReason)).toEqual(["closed_in_psa", null]);
  });

  it("closes the ticket when the asset is muted, saying the problem is no longer tracked", async () => {
    const s = await setup();
    await sync(s, at(1));
    await deliverAll(s, at(1));
    await db.withTenant(s.tenantId, ({ tx }) =>
      tx.asset.updateMany({
        where: { name: "FS01" },
        data: { mutedUntil: new Date("9999-12-31T00:00:00Z") },
      }),
    );
    await sync(s, at(2));
    await deliverAll(s, at(2));
    const ticket = s.fake.tickets[0]!;
    expect(ticket.status).toBe("Resolved");
    expect(ticket.comments.at(-1)!.body).toContain("No longer tracked: backup missed on FS01");
  });

  it("sends messages about one asset in order: a later one waits for an earlier one", async () => {
    const s = await setup();
    await sync(s, at(1));
    s.results.FS01!.push([at(2), "failed"]);
    await sync(s, at(3));
    const pending = await db.withTenant(s.tenantId, ({ tx }) =>
      tx.notificationBatch.findMany({
        where: { status: "pending" },
        orderBy: { createdAt: "asc" },
      }),
    );
    expect(pending).toHaveLength(2);
    expect(pending.every((b) => b.assetId === pending[0]!.assetId)).toBe(true);
    const claimLater = () =>
      db.withTenant(s.tenantId, (context) =>
        claimNotificationBatch(context, { batchId: pending[1]!.id, now: at(3), leaseMs: 60_000 }),
      );
    expect(await claimLater()).toBeNull();
    await deliverBatch(deps(s.fake, at(3)), { tenantId: s.tenantId, batchId: pending[0]!.id });
    expect(await claimLater()).not.toBeNull();
  });

  it("retries with a clear reason when Syncro refuses the token, and gives up on an invalid ticket", async () => {
    const s = await setup({ token: "not-the-token" });
    await sync(s, at(1));
    const [first] = await deliverAll(s, at(1));
    expect(first!.result).toBe("retrying");
    const batch = await db.withTenant(s.tenantId, ({ tx }) =>
      tx.notificationBatch.findFirstOrThrow({}),
    );
    expect(batch.lastError).toBe("Syncro refused the API token. Replace it on the channel.");

    const strict = await setup();
    strict.fake = fakeSyncro({ requireProblemType: true });
    await db.withTenant(strict.tenantId, ({ tx }) =>
      tx.notificationChannel.update({
        where: { id: strict.channelId },
        data: {
          config: {
            provider: "syncro",
            subdomain: "northwind",
            problemType: null,
            resolvedStatus: "Resolved",
          },
        },
      }),
    );
    await sync(strict, at(1));
    expect(await deliverAll(strict, at(1))).toEqual([
      expect.objectContaining({ result: "failed" }),
    ]);
    const failed = await db.withTenant(strict.tenantId, ({ tx }) =>
      tx.notificationBatch.findFirstOrThrow({}),
    );
    expect(failed.lastError).toBe("Syncro refused the request: Problem type can't be blank");
  });

  it("fails a message whose client was unmatched after it was queued", async () => {
    const s = await setup();
    await sync(s, at(1));
    await db.withTenant(s.tenantId, ({ tx }) => tx.psaCustomerMapping.deleteMany({}));
    expect(await deliverAll(s, at(1))).toEqual([expect.objectContaining({ result: "failed" })]);
    expect(s.fake.tickets).toHaveLength(0);
  });

  it("answers a test message by checking the token, without opening a ticket", async () => {
    const s = await setup();
    const batch = await db.withTenant(s.tenantId, ({ tx }) =>
      tx.notificationBatch.create({
        data: {
          tenantId: s.tenantId,
          channelId: s.channelId,
          kind: "test",
          payload: { type: "test" },
          nextAttemptAt: T0,
        },
      }),
    );
    expect(
      await deliverBatch(deps(s.fake, at(1)), { tenantId: s.tenantId, batchId: batch.id }),
    ).toMatchObject({
      result: "sent",
    });
    expect(s.fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /me"]);
    expect(s.fake.tickets).toHaveLength(0);
  });
});
