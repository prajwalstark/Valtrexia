import { randomUUID } from "node:crypto";
import { createDb, type Db } from "@valtrexia/db";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { muteAssets } from "./asset-settings-core";
import { getClientDetail, getFleetOverview } from "./dashboard-core";
import type { TenantSession } from "./session-core";
import { getWorkspaceSettings, updateWorkspaceSettings } from "./workspace-core";

const urls = inject("databaseUrls");
const HOUR = 3_600_000;
const NOW = new Date("2026-11-12T15:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const IP = "203.0.113.9";

let db: Db;
beforeAll(() => {
  db = createDb({ url: urls.app });
});
afterAll(async () => {
  await db.disconnect();
});

/** A workspace with an owner, a technician, and one client with one asset backed up late last night UTC. */
async function workspace() {
  const tenantId = await db.provisionTenant({
    clerkOrgId: `org_${randomUUID()}`,
    name: "Northwind IT",
  });
  return db.withTenant(tenantId, async ({ tx }) => {
    const user = async (role: "owner" | "technician") => {
      const row = await tx.user.create({
        data: { tenantId, clerkUserId: `user_${randomUUID()}`, email: `${role}@msp.example`, role },
      });
      return {
        tenantId,
        userId: row.id,
        clerkUserId: row.clerkUserId,
        role,
      } satisfies TenantSession;
    };
    const owner = await user("owner");
    const tech = await user("technician");
    const integration = await tx.integration.create({
      data: {
        tenantId,
        vendor: "mock",
        name: "Demo data",
        credentialsEnc: { v: 1 },
        syncStatus: "ok",
        lastSyncAt: ago(5 * 60_000),
        createdAt: ago(30 * 24 * HOUR),
      },
    });
    const client = await tx.client.create({ data: { tenantId, name: "Acme" } });
    const asset = await tx.asset.create({
      data: {
        tenantId,
        clientId: client.id,
        integrationId: integration.id,
        vendorAssetId: "fs",
        name: "fs",
        type: "agent",
        currentStatus: "success",
        firstSeenAt: ago(30 * 24 * HOUR),
        lastSuccessAt: new Date("2026-11-12T01:30:00Z"),
      },
    });
    // 01:30 UTC on the 12th: the 12th in UTC, the evening of the 11th in New York.
    await tx.backupResult.create({
      data: {
        tenantId,
        assetId: asset.id,
        integrationId: integration.id,
        vendorResultId: "r1",
        startedAt: new Date("2026-11-12T01:30:00Z"),
        endedAt: new Date("2026-11-12T01:40:00Z"),
        status: "success",
        vendorStatusRaw: "OK",
        rawPayload: {},
      },
    });
    return { tenantId, owner, tech, clientId: client.id, assetId: asset.id };
  });
}

const deps = () => ({ db, ip: IP });
const audit = (tenantId: string) =>
  db.withTenant(tenantId, ({ tx }) => tx.auditLog.findMany({ orderBy: { createdAt: "asc" } }));

describe("getWorkspaceSettings", () => {
  it("starts in UTC with two hours of grace, readable by anyone in the workspace", async () => {
    const w = await workspace();
    const expected = { name: "Northwind IT", timeZone: "UTC", graceHours: 2 };
    expect(await getWorkspaceSettings({ db }, w.owner)).toEqual(expected);
    expect(await getWorkspaceSettings({ db }, w.tech)).toEqual(expected);
  });
});

describe("updateWorkspaceSettings", () => {
  it("is for owners only", async () => {
    const w = await workspace();
    const state = await updateWorkspaceSettings(deps(), w.tech, {
      timeZone: "America/New_York",
      graceHours: "6",
    });
    expect(state).toEqual({
      status: "error",
      message: "Only workspace owners can change these settings.",
    });
    expect(await getWorkspaceSettings({ db }, w.tech)).toMatchObject({
      timeZone: "UTC",
      graceHours: 2,
    });
    expect(await audit(w.tenantId)).toEqual([]);
  });

  it("changes both and records what they were", async () => {
    const w = await workspace();
    const state = await updateWorkspaceSettings(deps(), w.owner, {
      timeZone: "America/New_York",
      graceHours: " 6 ",
    });
    expect(state).toEqual({
      status: "ok",
      message:
        "Saved. Incidents follow the new grace period from the next sync, within a few minutes.",
    });
    expect(await getWorkspaceSettings({ db }, w.owner)).toEqual({
      name: "Northwind IT",
      timeZone: "America/New_York",
      graceHours: 6,
    });
    expect(await audit(w.tenantId)).toMatchObject([
      {
        action: "workspace.settings_changed",
        actorUserId: w.owner.userId,
        targetType: "tenant",
        targetId: w.tenantId,
        ip: IP,
        metadata: {
          from: { timeZone: "UTC", graceHours: 2 },
          to: { timeZone: "America/New_York", graceHours: 6 },
        },
      },
    ]);
  });

  it("says less when only the time zone changed, and nothing when nothing did", async () => {
    const w = await workspace();
    const zone = await updateWorkspaceSettings(deps(), w.owner, {
      timeZone: "Europe/London",
      graceHours: "2",
    });
    expect(zone).toEqual({ status: "ok", message: "Saved." });

    const same = await updateWorkspaceSettings(deps(), w.owner, {
      timeZone: "Europe/London",
      graceHours: "2",
    });
    expect(same).toEqual({ status: "ok", message: "Nothing to change." });
    expect(await audit(w.tenantId)).toHaveLength(1);
  });

  it("accepts the bounds of the grace period, none and a week", async () => {
    const w = await workspace();
    for (const graceHours of ["0", "168"]) {
      const state = await updateWorkspaceSettings(deps(), w.owner, { timeZone: "UTC", graceHours });
      expect(state.status).toBe("ok");
      expect((await getWorkspaceSettings({ db }, w.owner)).graceHours).toBe(Number(graceHours));
    }
  });

  it.each(["", "  ", "-1", "169", "1.5", "two", null, undefined])(
    "refuses a grace period of %j, and does not read a blank as zero",
    async (graceHours) => {
      const w = await workspace();
      const state = await updateWorkspaceSettings(deps(), w.owner, { timeZone: "UTC", graceHours });
      expect(state).toMatchObject({
        status: "error",
        fieldErrors: { graceHours: expect.stringContaining("0 to 168") as string },
      });
      expect((await getWorkspaceSettings({ db }, w.owner)).graceHours).toBe(2);
    },
  );

  it.each(["", "Mars/Olympus_Mons", "EST", "america/new_york", null, 42])(
    "refuses the time zone %j",
    async (timeZone) => {
      const w = await workspace();
      const state = await updateWorkspaceSettings(deps(), w.owner, { timeZone, graceHours: "2" });
      expect(state).toMatchObject({
        status: "error",
        fieldErrors: { timeZone: "Choose a time zone from the list." },
      });
      expect((await getWorkspaceSettings({ db }, w.owner)).timeZone).toBe("UTC");
      expect(await audit(w.tenantId)).toEqual([]);
    },
  );

  it("changes only this workspace", async () => {
    const mine = await workspace();
    const theirs = await workspace();
    await updateWorkspaceSettings(deps(), mine.owner, { timeZone: "Asia/Tokyo", graceHours: "12" });
    expect(await getWorkspaceSettings({ db }, theirs.owner)).toMatchObject({
      timeZone: "UTC",
      graceHours: 2,
    });
    expect(await audit(theirs.tenantId)).toEqual([]);
  });

  it("the database refuses a grace period out of range and an absurd time zone", async () => {
    const w = await workspace();
    const set = (data: { graceHours?: number; timeZone?: string }) =>
      db.withTenant(w.tenantId, ({ tx }) => tx.tenant.update({ where: { id: w.tenantId }, data }));
    await expect(set({ graceHours: 169 })).rejects.toThrow();
    await expect(set({ graceHours: -1 })).rejects.toThrow();
    await expect(set({ timeZone: "" })).rejects.toThrow();
    await expect(set({ timeZone: "x".repeat(65) })).rejects.toThrow();
  });
});

describe("what the time zone changes", () => {
  it("moves a late-evening backup onto the workspace's own day", async () => {
    const w = await workspace();
    const utc = (await getClientDetail({ db }, w.owner, w.clientId, NOW))!;
    expect(utc.timeZone).toBe("UTC");
    expect(utc.assets[0]!.days.at(-1)).toMatchObject({ date: "2026-11-12", count: 1 });
    expect(utc.assets[0]!.days.at(-2)).toMatchObject({ date: "2026-11-11", count: 0 });

    await updateWorkspaceSettings(deps(), w.owner, {
      timeZone: "America/New_York",
      graceHours: "2",
    });
    const newYork = (await getClientDetail({ db }, w.owner, w.clientId, NOW))!;
    expect(newYork.timeZone).toBe("America/New_York");
    expect(newYork.assets[0]!.days.at(-1)).toMatchObject({ date: "2026-11-12", count: 0 });
    expect(newYork.assets[0]!.days.at(-2)).toMatchObject({ date: "2026-11-11", count: 1 });
    // The result itself is unchanged: the same moment, listed either way.
    expect(newYork.assets[0]!.results[0]!.startedAt).toEqual(new Date("2026-11-12T01:30:00Z"));
    expect((await getFleetOverview({ db }, w.owner, NOW)).timeZone).toBe("America/New_York");
  });

  it("keeps the whole period when the workspace's today is a day ahead of UTC's", async () => {
    const w = await workspace();
    await updateWorkspaceSettings(deps(), w.owner, {
      timeZone: "Pacific/Kiritimati",
      graceHours: "2",
    });
    // 15:00 UTC on the 12th is 05:00 on the 13th there.
    const detail = (await getClientDetail({ db }, w.owner, w.clientId, NOW))!;
    const days = detail.assets[0]!.days;
    expect(days).toHaveLength(14);
    expect(days.at(-1)!.date).toBe("2026-11-13");
    expect(days.at(-2)).toMatchObject({ date: "2026-11-12", count: 1 });
    expect(detail.assets[0]!.resultCount).toBe(1);
  });

  it("writes a mute's end date on the workspace's calendar", async () => {
    const w = await workspace();
    const mute = () =>
      muteAssets(
        { db, now: NOW },
        w.owner,
        { assetId: w.assetId },
        { duration: "7", reason: "Works" },
      );
    // Seven days from 15:00 UTC on the 12th is 15:00 UTC on the 19th...
    expect(await mute()).toMatchObject({ message: "Muted until 19 Nov 2026." });
    // ...which is already the 20th at UTC+14.
    await updateWorkspaceSettings(deps(), w.owner, {
      timeZone: "Pacific/Kiritimati",
      graceHours: "2",
    });
    expect(await mute()).toMatchObject({ message: "Muted until 20 Nov 2026." });
  });
});

describe("what the grace period changes", () => {
  it("applies to what pages show straight away", async () => {
    const w = await workspace();
    // The last sync was 30 hours ago and the last backup 31: with 2 hours of
    // grace the asset's 26-hour window has closed unseen; with 10 it has not.
    await db.withTenant(w.tenantId, async ({ tx }) => {
      await tx.integration.updateMany({ data: { lastSyncAt: ago(30 * HOUR) } });
      await tx.asset.updateMany({ data: { lastSuccessAt: ago(31 * HOUR) } });
    });
    expect((await getFleetOverview({ db }, w.owner, NOW)).assets.counts.unknown).toBe(1);

    await updateWorkspaceSettings(deps(), w.owner, { timeZone: "UTC", graceHours: "10" });
    expect((await getFleetOverview({ db }, w.owner, NOW)).assets.counts).toMatchObject({
      unknown: 0,
      success: 1,
    });
  });
});
