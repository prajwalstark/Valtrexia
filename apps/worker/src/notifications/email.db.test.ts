import { randomBytes, randomUUID } from "node:crypto";
import type { Connector, NormalizedStatus, VendorResult } from "@valtrexia/connectors";
import { brand } from "@valtrexia/core";
import {
  createLogger,
  EmailSendError,
  LocalKeyProvider,
  MemoryEmailSender,
  ResendEmailSender,
  Secret,
} from "@valtrexia/core/server";
import { FAKE_RESEND_KEY, fakeResend } from "@valtrexia/core/testing/fake-resend";
import {
  createDb,
  createEmailChannel,
  createIntegration,
  type ChannelPreferencesInput,
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
const logger = createLogger({ name: "email-test", level: "silent" });
beforeAll(() => {
  db = createDb({ url: urls.app });
});
afterAll(async () => {
  await db.disconnect();
});

const ALL: ChannelPreferencesInput = {
  incidentTypes: ["failed", "missed", "stale"],
  notifyOpened: true,
  notifyClosed: true,
  notifyIntegrationHealth: true,
};

/** One client, one asset whose last backup was 40 hours before T0: missed, once synced. */
async function setup(options: { timeZone?: string } = {}) {
  const tenantId = await db.provisionTenant({
    clerkOrgId: `org_${randomUUID()}`,
    name: "Northwind IT",
  });
  if (options.timeZone) {
    await db.withTenant(tenantId, ({ tx }) =>
      tx.tenant.update({ where: { id: tenantId }, data: { timeZone: options.timeZone! } }),
    );
  }
  const integration = await db.withTenant(tenantId, (context) =>
    createIntegration(context, keyProvider, {
      vendor: "mock",
      name: "Scripted",
      credentials: new Secret({ seed: "unused" }),
      actorUserId: null,
    }),
  );
  const result = (asset: string, when: Date, status: NormalizedStatus): VendorResult => ({
    vendorResultId: `${asset}-${when.getTime()}`,
    vendorAssetId: asset,
    startedAt: when,
    endedAt: when,
    vendorStatusRaw: status,
    message: null,
    screenshotVerified: null,
    rawPayload: { status },
  });
  const connector: Connector = {
    vendor: "mock",
    testConnection: async () => {},
    listClients: async () => [{ vendorClientId: "c1", name: "Acme Dental" }],
    listAssets: async () => [
      {
        vendorAssetId: "FS01",
        vendorClientId: "c1",
        name: "FS01",
        type: "agent",
        deviceName: null,
        expectedFrequencyHours: 24,
        isPaused: false,
        isArchived: false,
      },
    ],
    listResults: async () => [result("FS01", at(-40), "success")],
    normalizeStatus: (raw) => (raw as { status: NormalizedStatus }).status,
  };
  await syncIntegration(
    { db, keyProvider, logger, allowMock: true, now: () => T0, connectorFactory: () => connector },
    { tenantId, integrationId: integration.id },
  ).catch(() => undefined);
  return { tenantId, integrationId: integration.id, connector };
}

async function emailChannel(tenantId: string, recipients: string[], name = "On-call") {
  return db.withTenant(tenantId, (context) =>
    createEmailChannel(context, { name, recipients, preferences: ALL, actorUserId: null }),
  );
}

const sync = (s: Awaited<ReturnType<typeof setup>>, now: Date) =>
  syncIntegration(
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

const deliverAll = async (tenantId: string, deps: Partial<DeliveryDeps>, now = T0) => {
  const pending = await db.withTenant(tenantId, ({ tx }) =>
    tx.notificationBatch.findMany({ where: { status: "pending" } }),
  );
  const results = [];
  for (const batch of pending) {
    results.push(
      await deliverBatch(
        { db, keyProvider, logger, outboundPolicy: {}, emailSender: null, now: () => now, ...deps },
        { tenantId, batchId: batch.id },
      ),
    );
  }
  return results;
};

describe("email channels", () => {
  it("sends one email per sync to every recipient, in the workspace's time zone", async () => {
    const s = await setup({ timeZone: "America/New_York" });
    // setup() already synced once with no channel, so nothing was queued. Close
    // the incident it opened, and let a later sync reopen it with a channel present.
    await db.withTenant(s.tenantId, ({ tx }) => tx.incident.updateMany({ data: { closedAt: T0 } }));
    await emailChannel(s.tenantId, ["alex@msp.example", "sam@msp.example"]);
    await sync(s, at(1));

    const sender = new MemoryEmailSender();
    expect(await deliverAll(s.tenantId, { emailSender: sender }, at(1))).toMatchObject([
      { result: "sent" },
    ]);
    expect(sender.sent).toHaveLength(1);
    const [email] = sender.sent;
    expect(email!.to).toEqual(["alex@msp.example", "sam@msp.example"]);
    expect(email!.subject).toBe(`${brand.name}: 1 new backup problem at Acme Dental`);
    // 40 hours before T0 is 20:00 UTC on 10 Nov: 15:00 in New York.
    expect(email!.text).toContain("FS01: Backup missed. Last good backup 10 Nov, 15:00 GMT-5.");
    expect(email!.text).toContain('on the "On-call" notification channel');
    expect(email!.html).toContain("<li>FS01: Backup missed.");
    // Every attempt at one message carries the same key.
    const [batch] = await db.withTenant(s.tenantId, ({ tx }) => tx.notificationBatch.findMany());
    expect(email!.idempotencyKey).toBe(batch!.id);
  });

  it("is refused for good when this server has no email set up", async () => {
    const s = await setup();
    await db.withTenant(s.tenantId, ({ tx }) => tx.incident.updateMany({ data: { closedAt: T0 } }));
    await emailChannel(s.tenantId, ["alex@msp.example"]);
    await sync(s, at(1));
    expect(await deliverAll(s.tenantId, { emailSender: null }, at(1))).toMatchObject([
      { result: "failed" },
    ]);
    const [batch] = await db.withTenant(s.tenantId, ({ tx }) => tx.notificationBatch.findMany());
    expect(batch).toMatchObject({
      status: "failed",
      lastError: "Email is not set up on this server.",
    });
  });

  it("retries a provider failure that may pass, and gives up on one that will not", async () => {
    const s = await setup();
    await db.withTenant(s.tenantId, ({ tx }) => tx.incident.updateMany({ data: { closedAt: T0 } }));
    await emailChannel(s.tenantId, ["alex@msp.example"]);
    await sync(s, at(1));

    const sender = new MemoryEmailSender();
    sender.failure = new EmailSendError(true, "The email provider is not answering.");
    expect(await deliverAll(s.tenantId, { emailSender: sender }, at(1))).toMatchObject([
      { result: "retrying" },
    ]);
    sender.failure = new EmailSendError(false, "The email provider refused the sender address.");
    expect(await deliverAll(s.tenantId, { emailSender: sender }, at(2))).toMatchObject([
      { result: "failed" },
    ]);
    const [batch] = await db.withTenant(s.tenantId, ({ tx }) => tx.notificationBatch.findMany());
    expect(batch).toMatchObject({
      status: "failed",
      attempts: 2,
      lastError: "The email provider refused the sender address.",
    });
  });

  it("delivers through Resend: once, however often a delivery is retried", async () => {
    const s = await setup({ timeZone: "America/New_York" });
    await db.withTenant(s.tenantId, ({ tx }) => tx.incident.updateMany({ data: { closedAt: T0 } }));
    await emailChannel(s.tenantId, ["alex@msp.example", "sam@msp.example"]);
    await sync(s, at(1));

    const resend = fakeResend();
    const sender = new ResendEmailSender({
      apiKey: FAKE_RESEND_KEY,
      from: "Northwind Alerts <alerts@msp.example>",
      fetch: resend.fetch,
    });
    // Resend is down for the first attempt; the outbox tries again later.
    resend.failNext({ status: 503, name: "service_unavailable" });
    expect(await deliverAll(s.tenantId, { emailSender: sender }, at(1))).toMatchObject([
      { result: "retrying" },
    ]);
    const [waiting] = await db.withTenant(s.tenantId, ({ tx }) => tx.notificationBatch.findMany());
    expect(waiting!.lastError).toBe("The email service had a problem. It will be tried again.");

    expect(await deliverAll(s.tenantId, { emailSender: sender }, at(2))).toMatchObject([
      { result: "sent" },
    ]);
    expect(resend.delivered).toHaveLength(1);
    expect(resend.delivered[0]).toMatchObject({
      from: "Northwind Alerts <alerts@msp.example>",
      to: ["alex@msp.example", "sam@msp.example"],
      subject: `${brand.name}: 1 new backup problem at Acme Dental`,
    });
    expect(resend.delivered[0]!.text).toContain("10 Nov, 15:00 GMT-5");
    // Both attempts carried the same key, so a repeat could never send twice.
    const keys = resend.requests.map((r) => r.headers.get("idempotency-key"));
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]!.startsWith(`${waiting!.id}:`)).toBe(true);
  });

  it("the database refuses a webhook channel with no destination", async () => {
    const s = await setup();
    await expect(
      db.withTenant(s.tenantId, ({ tx }) =>
        tx.notificationChannel.create({
          data: {
            tenantId: s.tenantId,
            type: "webhook",
            name: "Broken",
            incidentTypes: ["failed"],
          },
        }),
      ),
    ).rejects.toThrow();
  });
});
