import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, loadClientMonthReport, type Db } from "./index";

const urls = inject("databaseUrls");
let db: Db;
beforeAll(() => {
  db = createDb({ url: urls.app });
});
afterAll(async () => {
  await db.disconnect();
});

const at = (iso: string) => new Date(iso);
const NOW = at("2026-11-23T12:00:00Z");

type Result = [startedAt: string, endedAt: string | null, status: "success" | "warning" | "failed"];

/**
 * A London workspace with one client, a daily asset and a weekly one.
 * October 2026 in London runs from 2026-09-30T23:00Z to 2026-10-31T24:00Z;
 * results are loaded from two days before, 2026-09-28T23:00Z.
 */
async function seed(results: { daily: Result[]; weekly: Result[] }) {
  const tenantId = await db.provisionTenant({ clerkOrgId: `org_${randomUUID()}`, name: "MSP" });
  return db.withTenant(tenantId, async ({ tx }) => {
    await tx.tenant.update({
      where: { id: tenantId },
      data: { timeZone: "Europe/London", graceHours: 2 },
    });
    const integration = await tx.integration.create({
      data: { tenantId, vendor: "mock", name: "Demo", credentialsEnc: { v: 1, ciphertext: "x" } },
    });
    const client = await tx.client.create({ data: { tenantId, name: "Acme" } });
    const assetIds: Record<string, string> = {};
    for (const [name, frequency, sla] of [
      ["daily", 24, 72],
      ["weekly", 168, 192],
    ] as const) {
      const asset = await tx.asset.create({
        data: {
          tenantId,
          clientId: client.id,
          integrationId: integration.id,
          vendorAssetId: name,
          name,
          type: "agent",
          currentStatus: "success",
          expectedFrequencyHours: frequency,
          slaHours: sla,
          firstSeenAt: at("2026-01-01T00:00:00Z"),
        },
      });
      assetIds[name] = asset.id;
      for (const [index, [startedAt, endedAt, status]] of results[name].entries()) {
        await tx.backupResult.create({
          data: {
            tenantId,
            assetId: asset.id,
            integrationId: integration.id,
            vendorResultId: String(index),
            startedAt: at(startedAt),
            endedAt: endedAt ? at(endedAt) : null,
            status,
            vendorStatusRaw: status,
            rawPayload: {},
          },
        });
      }
    }
    await tx.incident.createMany({
      data: [
        // Opened and closed in October, after four hours.
        {
          tenantId,
          assetId: assetIds.daily!,
          type: "failed",
          openedAt: at("2026-10-03T08:00:00Z"),
          closedAt: at("2026-10-03T12:00:00Z"),
        },
        // All in September: not this month's.
        {
          tenantId,
          assetId: assetIds.daily!,
          type: "missed",
          openedAt: at("2026-09-10T08:00:00Z"),
          closedAt: at("2026-09-11T08:00:00Z"),
        },
      ],
    });
    return { tenantId, clientId: client.id };
  });
}

const load = (tenantId: string, clientId: string, month = "2026-10") =>
  db.withTenant(tenantId, (context) =>
    loadClientMonthReport(context, { clientId, month, now: NOW }),
  );

describe("loadClientMonthReport", () => {
  it("loads the month in the workspace's time zone and builds the report", async () => {
    const { tenantId, clientId } = await seed({
      daily: [
        // Started in the lead-in window, finished on 1 October.
        ["2026-09-29T20:00:00Z", "2026-10-01T05:00:00Z", "success"],
        // 23:30 UTC on 31 October is still the 31st in London (back on UTC by then).
        ["2026-10-31T23:30:00Z", "2026-10-31T23:40:00Z", "failed"],
        // 00:30 on 1 November in London: next month.
        ["2026-11-01T00:30:00Z", "2026-11-01T00:40:00Z", "failed"],
      ],
      weekly: [],
    });
    const loaded = await load(tenantId, clientId);
    expect(loaded!.client.name).toBe("Acme");
    expect(loaded!.timeZone).toBe("Europe/London");
    const daily = loaded!.report.assets.find((asset) => asset.name === "daily")!;
    expect(daily.days).toHaveLength(31);
    // The 1st ends at 23:00 UTC, 18 hours after the long backup finished.
    expect(daily.days[0]).toMatchObject({ date: "2026-10-01", onSchedule: true, worst: null });
    expect(daily.days[30]).toMatchObject({ date: "2026-10-31", worst: "failed" });
    expect(daily.backups).toEqual({ completed: 0, failed: 1 });
    expect(loaded!.report.incidents.opened).toEqual({ failed: 1, missed: 0, stale: 0 });
    expect(loaded!.report.incidents.medianHoursToClose).toBe(4);
  });

  it("finds each asset's latest completion before the window, by when it finished", async () => {
    const { tenantId, clientId } = await seed({
      daily: [],
      weekly: [
        // Ran from 01:00 to 22:00 on 27 September.
        ["2026-09-27T01:00:00Z", "2026-09-27T22:00:00Z", "success"],
        // Started later, but never reported an end: complete at 10:00.
        ["2026-09-27T10:00:00Z", null, "warning"],
        // A failure is not a completion.
        ["2026-09-28T20:00:00Z", "2026-09-28T22:00:00Z", "failed"],
      ],
    });
    const loaded = await load(tenantId, clientId);
    const weekly = loaded!.report.assets.find((asset) => asset.name === "weekly")!;
    const cell = (date: string) => weekly.days.find((day) => day.date === date)!;
    // 170 hours (168 + 2 grace) after 22:00 on the 27th is midnight UTC on 5 October;
    // the 4th ends at 23:00 UTC, so it is on schedule, and the 5th is not.
    expect(cell("2026-10-04").onSchedule).toBe(true);
    expect(cell("2026-10-05").onSchedule).toBe(false);
  });

  it("returns null for another tenant's client, an unknown client and a malformed month", async () => {
    const first = await seed({ daily: [], weekly: [] });
    const second = await seed({ daily: [], weekly: [] });
    expect(await load(second.tenantId, first.clientId)).toBeNull();
    expect(await load(first.tenantId, randomUUID())).toBeNull();
    expect(await load(first.tenantId, first.clientId, "2026-13")).toBeNull();
    expect(await load(first.tenantId, first.clientId, "October")).toBeNull();
  });
});
