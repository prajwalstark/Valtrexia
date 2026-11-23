import { randomBytes, randomUUID } from "node:crypto";
import { createLogger, MemoryEmailSender, LocalKeyProvider } from "@valtrexia/core/server";
import type { MonthlyReportPayload } from "@valtrexia/core";
import {
  createDb,
  createEmailChannel,
  queueMonthlyReportNotifications,
  type ChannelPreferencesInput,
  type Db,
} from "@valtrexia/db";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { deliverBatch } from "../notifications/deliver";
import { queueMonthlyDigests } from "./digest";

const urls = inject("databaseUrls");
let db: Db;
const logger = createLogger({ name: "digest-test", level: "silent" });
beforeAll(() => {
  db = createDb({ url: urls.app });
});
afterAll(async () => {
  await db.disconnect();
});

const PREFS: ChannelPreferencesInput = {
  incidentTypes: ["failed", "missed", "stale"],
  notifyOpened: true,
  notifyClosed: true,
  notifyIntegrationHealth: true,
  notifyMonthlyReport: true,
};

/** A workspace with one client, one daily asset backed up every day of October, and a channel. */
async function workspace(
  options: { timeZone?: string; wantsReport?: boolean; enabled?: boolean; deleting?: boolean } = {},
) {
  const tenantId = await db.provisionTenant({
    clerkOrgId: `org_${randomUUID()}`,
    name: "Northwind IT",
  });
  await db.withTenant(tenantId, async (context) => {
    const { tx } = context;
    await tx.tenant.update({
      where: { id: tenantId },
      data: {
        timeZone: options.timeZone ?? "Europe/London",
        ...(options.deleting
          ? {
              deletionRequestedAt: new Date("2026-10-30T00:00:00Z"),
              deleteAfter: new Date("2026-11-29T00:00:00Z"),
              deletionReason: "owner_request" as const,
            }
          : {}),
      },
    });
    const integration = await tx.integration.create({
      data: { tenantId, vendor: "mock", name: "Demo", credentialsEnc: { v: 1, ciphertext: "x" } },
    });
    const client = await tx.client.create({ data: { tenantId, name: "Acme Dental" } });
    const asset = await tx.asset.create({
      data: {
        tenantId,
        clientId: client.id,
        integrationId: integration.id,
        vendorAssetId: "srv",
        name: "SRV01",
        type: "agent",
        currentStatus: "success",
        firstSeenAt: new Date("2026-09-01T00:00:00Z"),
      },
    });
    await tx.backupResult.createMany({
      data: Array.from({ length: 31 }, (_, i) => ({
        tenantId,
        assetId: asset.id,
        integrationId: integration.id,
        vendorResultId: String(i),
        startedAt: new Date(Date.UTC(2026, 9, i + 1, 1)),
        endedAt: new Date(Date.UTC(2026, 9, i + 1, 2)),
        status: i === 4 ? ("failed" as const) : ("success" as const),
        vendorStatusRaw: "x",
        rawPayload: {},
      })),
    });
    const channel = await createEmailChannel(context, {
      name: "Owners",
      recipients: ["owners@msp.example"],
      preferences: { ...PREFS, notifyMonthlyReport: options.wantsReport ?? true },
      actorUserId: null,
    });
    if (options.enabled === false) {
      await tx.notificationChannel.update({ where: { id: channel.id }, data: { enabled: false } });
    }
  });
  return tenantId;
}

const batchesOf = (tenantId: string) =>
  db.withTenant(tenantId, ({ tx }) =>
    tx.notificationBatch.findMany({
      where: { kind: "report" },
      select: { id: true, payload: true },
    }),
  );

// 06:00 UTC on 1 November is 06:00 in London, but still 31 October in Los Angeles.
const FIRST = new Date("2026-11-01T06:00:00Z");

describe("monthly summaries", () => {
  it("queues last month's summary once, for workspaces early in their month with a channel that wants it", async () => {
    const due = await workspace();
    const notWanted = await workspace({ wantsReport: false });
    const channelOff = await workspace({ enabled: false });
    const stillOctober = await workspace({ timeZone: "America/Los_Angeles" });
    const deleting = await workspace({ deleting: true });
    const mine = new Set([due, notWanted, channelOff, stillOctober, deleting]);

    const listed = (await db.listReportDigestTenants({ now: FIRST })).filter((row) =>
      mine.has(row.tenantId),
    );
    expect(listed).toEqual([{ tenantId: due, month: "2026-10" }]);

    const run = () => queueMonthlyDigests({ db, logger, now: () => FIRST }, { onlyTenants: mine });
    expect(await run()).toEqual({ tenants: 1, messages: 1, failed: 0 });
    // Already sent: neither listed nor queued again.
    expect(await run()).toEqual({ tenants: 0, messages: 0, failed: 0 });

    const [batch] = await batchesOf(due);
    const payload = batch!.payload as unknown as MonthlyReportPayload;
    expect(payload.type).toBe("report.monthly");
    expect(payload.data.month).toBe("2026-10");
    expect(payload.data.clients).toEqual([
      expect.objectContaining({
        name: "Acme Dental",
        assets: 1,
        backups: { completed: 30, failed: 1 },
      }),
    ]);
    for (const other of [notWanted, channelOff, stillOctober, deleting]) {
      expect(await batchesOf(other)).toEqual([]);
    }

    // Los Angeles reaches November seven hours later, and gets October then.
    const later = new Date("2026-11-01T08:00:00Z");
    expect(
      (await db.listReportDigestTenants({ now: later })).filter((row) => mine.has(row.tenantId)),
    ).toEqual([{ tenantId: stillOctober, month: "2026-10" }]);
  });

  it("skips a month whose first week has passed", async () => {
    const tenantId = await workspace();
    const eighth = new Date("2026-11-08T12:00:00Z");
    expect(
      (await db.listReportDigestTenants({ now: eighth })).filter(
        (row) => row.tenantId === tenantId,
      ),
    ).toEqual([]);
    const seventh = new Date("2026-11-07T23:00:00Z");
    expect(
      (await db.listReportDigestTenants({ now: seventh })).filter(
        (row) => row.tenantId === tenantId,
      ),
    ).toEqual([{ tenantId, month: "2026-10" }]);
  });

  it("queues the month once when two workers race for it", async () => {
    const tenantId = await workspace();
    const queue = () =>
      db.withTenant(tenantId, (context) =>
        queueMonthlyReportNotifications(context, { month: "2026-10", now: FIRST, reports: [] }),
      );
    const outcomes = await Promise.all([queue(), queue(), queue()]);
    expect(outcomes.filter((n) => n === 1)).toHaveLength(1);
    expect(outcomes.filter((n) => n === null)).toHaveLength(2);
    expect(await batchesOf(tenantId)).toHaveLength(1);
  });

  it("emails the summary, with links when the app's address is set", async () => {
    const tenantId = await workspace();
    await queueMonthlyDigests(
      { db, logger, now: () => FIRST },
      { onlyTenants: new Set([tenantId]) },
    );
    const [batch] = await batchesOf(tenantId);
    const sender = new MemoryEmailSender();
    const result = await deliverBatch(
      {
        db,
        keyProvider: new LocalKeyProvider(randomBytes(32).toString("base64")),
        logger,
        outboundPolicy: {},
        emailSender: sender,
        appBaseUrl: "https://app.example.com",
        now: () => FIRST,
      },
      { tenantId, batchId: batch!.id },
    );
    expect(result.result).toBe("sent");
    const [email] = sender.sent;
    expect(email!.to).toEqual(["owners@msp.example"]);
    expect(email!.subject).toMatch(/backup summary for October 2026$/);
    expect(email!.text).toContain("Acme Dental");
    expect(email!.text).toMatch(
      /https:\/\/app\.example\.com\/clients\/[0-9a-f-]+\/report\?month=2026-10/,
    );
  });
});
