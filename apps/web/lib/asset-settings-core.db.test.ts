import { randomUUID } from "node:crypto";
import { MUTED_INDEFINITELY } from "@valtrexia/core";
import { createDb, type Db } from "@valtrexia/db";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  muteAssets,
  unmuteAssets,
  updateBackupExpectations,
  type SettingsState,
} from "./asset-settings-core";
import { getClientDetail, getFleetOverview } from "./dashboard-core";
import type { TenantSession } from "./session-core";

const urls = inject("databaseUrls");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
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

/**
 * A workspace with an owner and a technician, and two clients:
 *   Acme:  sql (failed, with failed + missed + stale incidents, past its SLA),
 *          fs (healthy), old (archived)
 *   Other: web (healthy)
 */
async function workspace() {
  const tenantId = await db.provisionTenant({ clerkOrgId: `org_${randomUUID()}`, name: "MSP" });
  return db.withTenant(tenantId, async ({ tx }) => {
    const user = async (role: "owner" | "technician", name: string) => {
      const row = await tx.user.create({
        data: {
          tenantId,
          clerkUserId: `user_${randomUUID()}`,
          email: `${role}@msp.example`,
          name,
          role,
        },
      });
      return {
        tenantId,
        userId: row.id,
        clerkUserId: row.clerkUserId,
        role,
      } satisfies TenantSession;
    };
    const owner = await user("owner", "Olive Owner");
    const tech = await user("technician", "Terry Tech");

    const integration = await tx.integration.create({
      data: {
        tenantId,
        vendor: "mock",
        name: "Demo data",
        credentialsEnc: { v: 1 },
        syncStatus: "ok",
        lastSyncAt: ago(5 * 60_000),
        createdAt: ago(30 * DAY),
      },
    });
    const assets: Record<string, string> = {};
    const clients: Record<string, string> = {};
    const add = async (
      clientName: string,
      name: string,
      data: { currentStatus?: "failed" | "success"; isArchived?: boolean; staleSince?: Date } = {},
    ) => {
      clients[clientName] ??= (await tx.client.create({ data: { tenantId, name: clientName } })).id;
      const asset = await tx.asset.create({
        data: {
          tenantId,
          clientId: clients[clientName],
          integrationId: integration.id,
          vendorAssetId: `${clientName}/${name}`,
          name,
          type: "agent",
          currentStatus: data.currentStatus ?? "success",
          isArchived: data.isArchived ?? false,
          staleSince: data.staleSince ?? null,
          firstSeenAt: ago(30 * DAY),
          lastSuccessAt: ago(data.currentStatus === "failed" ? 100 * HOUR : 3 * HOUR),
        },
      });
      assets[name] = asset.id;
    };
    await add("Acme", "sql", { currentStatus: "failed", staleSince: ago(28 * HOUR) });
    await add("Acme", "fs");
    await add("Acme", "old", { isArchived: true });
    await add("Other", "web");
    for (const type of ["failed", "missed", "stale"] as const) {
      await tx.incident.create({
        data: { tenantId, assetId: assets.sql!, type, openedAt: ago(20 * HOUR) },
      });
    }
    return { tenantId, owner, tech, assets, clients };
  });
}

type Workspace = Awaited<ReturnType<typeof workspace>>;

const deps = () => ({ db, ip: IP, now: NOW });
const asset = (w: Workspace, name: string) =>
  db.withTenant(w.tenantId, ({ tx }) =>
    tx.asset.findUniqueOrThrow({ where: { id: w.assets[name]! } }),
  );
const openIncidents = (w: Workspace) =>
  db.withTenant(w.tenantId, ({ tx }) => tx.incident.count({ where: { closedAt: null } }));
const audit = (w: Workspace) =>
  db.withTenant(w.tenantId, async ({ tx }) =>
    (await tx.auditLog.findMany({ orderBy: { createdAt: "asc" } })).map((entry) => ({
      action: entry.action,
      actorUserId: entry.actorUserId,
      targetType: entry.targetType,
      targetId: entry.targetId,
      metadata: entry.metadata as Record<string, unknown>,
      ip: entry.ip,
    })),
  );
const message = (state: SettingsState) => (state.status === "idle" ? "" : state.message);

describe("muteAssets: one asset", () => {
  it("mutes it until the date, records who and why, and closes its open incidents", async () => {
    const w = await workspace();
    const state = await muteAssets(
      deps(),
      w.tech,
      { assetId: w.assets.sql! },
      { duration: "7", reason: "  Server being replaced this week  " },
    );
    expect(state).toEqual({
      status: "ok",
      clientId: w.clients.Acme,
      message: "Muted until 19 Nov 2026. 3 open incidents were closed.",
    });

    expect(await asset(w, "sql")).toMatchObject({
      mutedUntil: new Date("2026-11-19T15:00:00Z"),
      mutedReason: "Server being replaced this week",
      mutedByUserId: w.tech.userId,
      mutedAt: NOW,
      staleSince: null,
    });
    expect(await openIncidents(w)).toBe(0);
    const closed = await db.withTenant(w.tenantId, ({ tx }) => tx.incident.findMany());
    expect(closed.every((incident) => incident.closedAt?.getTime() === NOW.getTime())).toBe(true);

    // Nothing else was touched.
    expect(await asset(w, "fs")).toMatchObject({ mutedUntil: null, mutedReason: null });

    expect(await audit(w)).toEqual([
      {
        action: "asset.muted",
        actorUserId: w.tech.userId,
        targetType: "asset",
        targetId: w.assets.sql,
        ip: IP,
        metadata: {
          until: "2026-11-19T15:00:00.000Z",
          indefinite: false,
          reason: "Server being replaced this week",
          previousUntil: null,
          incidentsClosed: 3,
          clientId: w.clients.Acme,
          bulk: false,
        },
      },
    ]);
  });

  it("takes the asset out of health and the incident count straight away", async () => {
    const w = await workspace();
    const before = await getFleetOverview({ db }, w.owner, NOW);
    expect(before).toMatchObject({ openIncidents: 3, assets: { watched: 3, pastSla: 1 } });
    expect(before.clients.find((c) => c.name === "Acme")!.summary.health).toBe("red");

    await muteAssets(
      deps(),
      w.tech,
      { assetId: w.assets.sql! },
      { duration: "1", reason: "Maintenance" },
    );

    const after = await getFleetOverview({ db }, w.owner, NOW);
    expect(after).toMatchObject({
      openIncidents: 0,
      assets: { watched: 2, excluded: 2, pastSla: 0 },
    });
    expect(after.clients.find((c) => c.name === "Acme")!.summary.health).toBe("green");
  });

  it("lets a technician mute for exactly 30 days and no longer", async () => {
    const w = await workspace();
    const target = { assetId: w.assets.fs! };
    const thirty = await muteAssets(deps(), w.tech, target, {
      duration: "30",
      reason: "Site closed",
    });
    expect(thirty.status).toBe("ok");
    expect((await asset(w, "fs")).mutedUntil).toEqual(new Date(NOW.getTime() + 30 * DAY));

    for (const duration of ["31", "90", "365", "indefinite"]) {
      const refused = await muteAssets(
        deps(),
        w.tech,
        { assetId: w.assets.sql! },
        { duration, reason: "Site closed" },
      );
      expect(refused).toMatchObject({
        status: "error",
        fieldErrors: { duration: expect.stringContaining("up to 30 days") as string },
      });
    }
    expect((await asset(w, "sql")).mutedUntil).toBeNull();
    expect(await openIncidents(w)).toBe(3);
    expect(await audit(w)).toHaveLength(1);
  });

  it("lets an owner mute for longer, or with no end date", async () => {
    const w = await workspace();
    await muteAssets(
      deps(),
      w.owner,
      { assetId: w.assets.fs! },
      { duration: "90", reason: "Seasonal site" },
    );
    expect((await asset(w, "fs")).mutedUntil).toEqual(new Date(NOW.getTime() + 90 * DAY));

    const forever = await muteAssets(
      deps(),
      w.owner,
      { assetId: w.assets.sql! },
      { duration: "indefinite", reason: "Decommissioned, kept for records" },
    );
    expect(message(forever)).toBe("Muted until someone unmutes it. 3 open incidents were closed.");
    expect((await asset(w, "sql")).mutedUntil).toEqual(MUTED_INDEFINITELY);
    expect((await audit(w)).at(-1)!.metadata).toMatchObject({ until: null, indefinite: true });

    // A century on, it is still not being watched.
    const later = await getFleetOverview({ db }, w.owner, new Date("2126-01-01T00:00:00Z"));
    expect(later.assets.excluded).toBeGreaterThanOrEqual(2);
  });

  it("refuses more than a year even from an owner", async () => {
    const w = await workspace();
    const state = await muteAssets(
      deps(),
      w.owner,
      { assetId: w.assets.fs! },
      { duration: "366", reason: "Too long" },
    );
    expect(state).toMatchObject({
      status: "error",
      fieldErrors: { duration: expect.any(String) as string },
    });
    expect((await asset(w, "fs")).mutedUntil).toBeNull();
  });

  it.each([
    ["nothing", ""],
    ["two characters", "ok"],
    ["only spaces", "      "],
    ["501 characters", "x".repeat(501)],
    ["not text", 42],
  ])("needs a reason: refuses %s", async (_label, reason) => {
    const w = await workspace();
    const state = await muteAssets(
      deps(),
      w.owner,
      { assetId: w.assets.fs! },
      { duration: "7", reason },
    );
    expect(state).toMatchObject({
      status: "error",
      fieldErrors: { reason: expect.any(String) as string },
    });
    expect((await asset(w, "fs")).mutedUntil).toBeNull();
    expect(await audit(w)).toEqual([]);
  });

  it.each(["", "abc", "0", "-1", "1.5", null, undefined, "7 days"])(
    "refuses a duration of %j",
    async (duration) => {
      const w = await workspace();
      const state = await muteAssets(
        deps(),
        w.owner,
        { assetId: w.assets.fs! },
        { duration, reason: "Valid reason" },
      );
      expect(state).toMatchObject({
        status: "error",
        fieldErrors: { duration: expect.any(String) as string },
      });
      expect((await asset(w, "fs")).mutedUntil).toBeNull();
    },
  );

  it("records what the mute replaced when an asset is muted again", async () => {
    const w = await workspace();
    const target = { assetId: w.assets.fs! };
    await muteAssets(deps(), w.owner, target, {
      duration: "indefinite",
      reason: "Until further notice",
    });
    await muteAssets(deps(), w.tech, target, { duration: "3", reason: "Back on Monday" });

    expect(await asset(w, "fs")).toMatchObject({
      mutedUntil: new Date(NOW.getTime() + 3 * DAY),
      mutedReason: "Back on Monday",
      mutedByUserId: w.tech.userId,
    });
    expect((await audit(w)).map((entry) => entry.metadata.previousUntil)).toEqual([
      null,
      "indefinite",
    ]);
  });
});

describe("what the client page is told about a mute", () => {
  it("shows who muted an asset, until when and why, and counts muted assets", async () => {
    const w = await workspace();
    const before = (await getClientDetail({ db }, w.owner, w.clients.Acme!, NOW))!;
    expect(before).toMatchObject({ settableAssets: 2, mutedAssets: 0 });
    expect(before.assets.every((a) => a.mute === null)).toBe(true);

    await muteAssets(
      deps(),
      w.tech,
      { assetId: w.assets.sql! },
      { duration: "7", reason: "Being replaced" },
    );
    await muteAssets(
      deps(),
      w.owner,
      { assetId: w.assets.fs! },
      { duration: "indefinite", reason: "Retired" },
    );

    const detail = (await getClientDetail({ db }, w.owner, w.clients.Acme!, NOW))!;
    expect(detail).toMatchObject({ settableAssets: 2, mutedAssets: 2, openIncidents: [] });
    const byName = Object.fromEntries(detail.assets.map((a) => [a.name, a]));
    expect(byName.sql).toMatchObject({
      watched: false,
      staleSince: null,
      mute: {
        until: new Date("2026-11-19T15:00:00Z"),
        reason: "Being replaced",
        by: "Terry Tech",
        at: NOW,
      },
    });
    // No end date is told as such, not as a date in the year 9999.
    expect(byName.fs!.mute).toEqual({ until: null, reason: "Retired", by: "Olive Owner", at: NOW });
    expect(byName.old!.mute).toBeNull();
  });

  it("stops showing a mute once it has ended, without anyone unmuting", async () => {
    const w = await workspace();
    await muteAssets(
      deps(),
      w.tech,
      { assetId: w.assets.fs! },
      { duration: "1", reason: "Overnight work" },
    );

    const during = (await getClientDetail(
      { db },
      w.owner,
      w.clients.Acme!,
      new Date(NOW.getTime() + 23 * HOUR),
    ))!;
    expect(during.assets.find((a) => a.name === "fs")).toMatchObject({ watched: false });
    expect(during.mutedAssets).toBe(1);

    const after = (await getClientDetail(
      { db },
      w.owner,
      w.clients.Acme!,
      new Date(NOW.getTime() + 25 * HOUR),
    ))!;
    expect(after.assets.find((a) => a.name === "fs")).toMatchObject({ watched: true, mute: null });
    expect(after.mutedAssets).toBe(0);
  });
});

describe("muteAssets: every asset of a client", () => {
  it("mutes all but the archived ones, with an audit entry for each", async () => {
    const w = await workspace();
    const state = await muteAssets(
      deps(),
      w.tech,
      { clientId: w.clients.Acme! },
      { duration: "14", reason: "Office move" },
    );
    expect(state).toEqual({
      status: "ok",
      clientId: w.clients.Acme,
      message: "Muted 2 assets until 26 Nov 2026. 3 open incidents were closed.",
    });

    const until = new Date(NOW.getTime() + 14 * DAY);
    expect((await asset(w, "sql")).mutedUntil).toEqual(until);
    expect((await asset(w, "fs")).mutedUntil).toEqual(until);
    expect((await asset(w, "old")).mutedUntil).toBeNull();
    // The other client is not touched.
    expect((await asset(w, "web")).mutedUntil).toBeNull();

    const entries = await audit(w);
    expect(entries.map((entry) => [entry.action, entry.targetId, entry.metadata.bulk])).toEqual(
      expect.arrayContaining([
        ["asset.muted", w.assets.fs, true],
        ["asset.muted", w.assets.sql, true],
      ]),
    );
    expect(entries).toHaveLength(2);
    expect(entries.find((entry) => entry.targetId === w.assets.sql)!.metadata.incidentsClosed).toBe(
      3,
    );
    expect(entries.find((entry) => entry.targetId === w.assets.fs)!.metadata.incidentsClosed).toBe(
      0,
    );
  });

  it("applies the same limits as for one asset", async () => {
    const w = await workspace();
    const state = await muteAssets(
      deps(),
      w.tech,
      { clientId: w.clients.Acme! },
      { duration: "indefinite", reason: "Trying it on" },
    );
    expect(state.status).toBe("error");
    expect((await asset(w, "fs")).mutedUntil).toBeNull();
  });
});

describe("unmuteAssets", () => {
  it("clears the mute and everything recorded with it, and audits what it was", async () => {
    const w = await workspace();
    const target = { assetId: w.assets.fs! };
    await muteAssets(deps(), w.owner, target, {
      duration: "indefinite",
      reason: "Until further notice",
    });

    // A technician may undo an owner's mute: it can only show more.
    const state = await unmuteAssets(deps(), w.tech, target);
    expect(state).toEqual({
      status: "ok",
      clientId: w.clients.Acme,
      message: "Unmuted. Any problems reappear at the next sync, within a few minutes.",
    });
    expect(await asset(w, "fs")).toMatchObject({
      mutedUntil: null,
      mutedReason: null,
      mutedByUserId: null,
      mutedAt: null,
    });
    expect((await audit(w)).at(-1)).toMatchObject({
      action: "asset.unmuted",
      actorUserId: w.tech.userId,
      targetId: w.assets.fs,
      metadata: {
        previousUntil: "indefinite",
        previousReason: "Until further notice",
        bulk: false,
      },
    });
  });

  it("does nothing, and records nothing, for an asset that is not muted", async () => {
    const w = await workspace();
    const state = await unmuteAssets(deps(), w.tech, { assetId: w.assets.fs! });
    expect(state).toMatchObject({ status: "ok", message: "It is not muted." });
    expect(await audit(w)).toEqual([]);
  });

  it("unmutes every muted asset of a client and leaves the rest", async () => {
    const w = await workspace();
    await muteAssets(
      deps(),
      w.tech,
      { clientId: w.clients.Acme! },
      { duration: "7", reason: "Office move" },
    );
    await muteAssets(
      deps(),
      w.tech,
      { assetId: w.assets.web! },
      { duration: "7", reason: "Separate matter" },
    );

    const state = await unmuteAssets(deps(), w.tech, { clientId: w.clients.Acme! });
    expect(message(state)).toBe(
      "Unmuted 2 assets. Any problems reappear at the next sync, within a few minutes.",
    );
    expect((await asset(w, "sql")).mutedUntil).toBeNull();
    expect((await asset(w, "fs")).mutedUntil).toBeNull();
    expect((await asset(w, "web")).mutedUntil).not.toBeNull();
    expect((await audit(w)).filter((entry) => entry.action === "asset.unmuted")).toHaveLength(2);

    const again = await unmuteAssets(deps(), w.tech, { clientId: w.clients.Acme! });
    expect(message(again)).toBe("No assets of this client are muted.");
  });
});

describe("updateBackupExpectations", () => {
  it("is for owners only", async () => {
    const w = await workspace();
    const state = await updateBackupExpectations(
      deps(),
      w.tech,
      { assetId: w.assets.fs! },
      { expectedFrequencyHours: "12", slaHours: "48" },
    );
    expect(state).toEqual({
      status: "error",
      message: "Only workspace owners can change the expected frequency or the SLA.",
    });
    expect(await asset(w, "fs")).toMatchObject({ expectedFrequencyHours: 24, slaHours: 72 });
    expect(await audit(w)).toEqual([]);
  });

  it("changes both and records what they were", async () => {
    const w = await workspace();
    const state = await updateBackupExpectations(
      deps(),
      w.owner,
      { assetId: w.assets.fs! },
      { expectedFrequencyHours: "12", slaHours: " 48 " },
    );
    expect(state).toEqual({
      status: "ok",
      clientId: w.clients.Acme,
      message: "Saved. Takes effect at the next sync, within a few minutes.",
    });
    expect(await asset(w, "fs")).toMatchObject({ expectedFrequencyHours: 12, slaHours: 48 });
    expect(await audit(w)).toEqual([
      {
        action: "asset.expectations_changed",
        actorUserId: w.owner.userId,
        targetType: "asset",
        targetId: w.assets.fs,
        ip: IP,
        metadata: {
          from: { expectedFrequencyHours: 24, slaHours: 72 },
          to: { expectedFrequencyHours: 12, slaHours: 48 },
          clientId: w.clients.Acme,
          bulk: false,
        },
      },
    ]);
  });

  it("leaves a blank field as it is", async () => {
    const w = await workspace();
    await updateBackupExpectations(
      deps(),
      w.owner,
      { assetId: w.assets.fs! },
      { expectedFrequencyHours: "", slaHours: "96" },
    );
    expect(await asset(w, "fs")).toMatchObject({ expectedFrequencyHours: 24, slaHours: 96 });
  });

  it("accepts an SLA shorter than the backup window, and the page shows the one applied", async () => {
    const w = await workspace();
    const state = await updateBackupExpectations(
      deps(),
      w.owner,
      { assetId: w.assets.fs! },
      { expectedFrequencyHours: "168", slaHours: "72" },
    );
    expect(state.status).toBe("ok");
    // Stored as entered; applied as the 168-hour window plus 2 hours of grace.
    expect(await asset(w, "fs")).toMatchObject({ expectedFrequencyHours: 168, slaHours: 72 });
    const detail = (await getClientDetail({ db }, w.owner, w.clients.Acme!, NOW))!;
    expect(detail.assets.find((a) => a.name === "fs")).toMatchObject({
      expectedFrequencyHours: 168,
      configuredSlaHours: 72,
      slaHours: 170,
    });
  });

  it("records nothing when the values are the ones already set", async () => {
    const w = await workspace();
    const state = await updateBackupExpectations(
      deps(),
      w.owner,
      { assetId: w.assets.fs! },
      { expectedFrequencyHours: "24", slaHours: "72" },
    );
    expect(state).toMatchObject({ status: "ok", message: "Nothing to change." });
    expect(await audit(w)).toEqual([]);
  });

  it.each(["0", "-3", "8761", "1.5", "abc", "12 hours"])("refuses %j hours", async (hours) => {
    const w = await workspace();
    const state = await updateBackupExpectations(
      deps(),
      w.owner,
      { assetId: w.assets.fs! },
      { expectedFrequencyHours: hours, slaHours: hours },
    );
    expect(state).toMatchObject({
      status: "error",
      fieldErrors: {
        expectedFrequencyHours: expect.stringContaining("1 to 8760") as string,
        slaHours: expect.stringContaining("1 to 8760") as string,
      },
    });
    expect(await asset(w, "fs")).toMatchObject({ expectedFrequencyHours: 24, slaHours: 72 });
  });

  it("accepts the bounds, one hour and one year", async () => {
    const w = await workspace();
    const state = await updateBackupExpectations(
      deps(),
      w.owner,
      { assetId: w.assets.fs! },
      { expectedFrequencyHours: "1", slaHours: "8760" },
    );
    expect(state.status).toBe("ok");
    expect(await asset(w, "fs")).toMatchObject({ expectedFrequencyHours: 1, slaHours: 8760 });
  });

  it("refuses two blanks", async () => {
    const w = await workspace();
    const state = await updateBackupExpectations(
      deps(),
      w.owner,
      { assetId: w.assets.fs! },
      { expectedFrequencyHours: "", slaHours: null },
    );
    expect(state).toEqual({ status: "error", message: "Enter a frequency, an SLA, or both." });
  });

  it("changes every asset of a client that is not archived, auditing only those that changed", async () => {
    const w = await workspace();
    await updateBackupExpectations(
      deps(),
      w.owner,
      { assetId: w.assets.fs! },
      { expectedFrequencyHours: "", slaHours: "48" },
    );
    const state = await updateBackupExpectations(
      deps(),
      w.owner,
      { clientId: w.clients.Acme! },
      { expectedFrequencyHours: "", slaHours: "48" },
    );
    // fs already had 48; only sql changes.
    expect(message(state)).toBe(
      "Changed 1 asset. Takes effect at the next sync, within a few minutes.",
    );
    expect((await asset(w, "sql")).slaHours).toBe(48);
    expect((await asset(w, "old")).slaHours).toBe(72);
    expect((await asset(w, "web")).slaHours).toBe(72);
    const entries = (await audit(w)).filter((entry) => entry.metadata.bulk === true);
    expect(entries.map((entry) => entry.targetId)).toEqual([w.assets.sql]);
  });

  it("the database itself refuses hours outside one to 8760", async () => {
    const w = await workspace();
    const set = (data: { slaHours?: number; expectedFrequencyHours?: number }) =>
      db.withTenant(w.tenantId, ({ tx }) => tx.asset.update({ where: { id: w.assets.fs! }, data }));
    await expect(set({ slaHours: 8761 })).rejects.toThrow();
    await expect(set({ slaHours: 0 })).rejects.toThrow();
    await expect(set({ expectedFrequencyHours: 8761 })).rejects.toThrow();
    await expect(set({ expectedFrequencyHours: 0 })).rejects.toThrow();
  });
});

describe("asset settings: tenants and ids", () => {
  it("cannot touch another tenant's asset or client: they do not exist", async () => {
    const mine = await workspace();
    const theirs = await workspace();
    const theirAsset = { assetId: theirs.assets.sql! };
    const theirClient = { clientId: theirs.clients.Acme! };
    const mute = { duration: "7", reason: "Not mine to mute" };
    const hours = { expectedFrequencyHours: "1", slaHours: "1" };

    for (const state of [
      await muteAssets(deps(), mine.owner, theirAsset, mute),
      await unmuteAssets(deps(), mine.owner, theirAsset),
      await updateBackupExpectations(deps(), mine.owner, theirAsset, hours),
    ]) {
      expect(state).toEqual({ status: "error", message: "That asset no longer exists." });
    }
    for (const state of [
      await muteAssets(deps(), mine.owner, theirClient, mute),
      await unmuteAssets(deps(), mine.owner, theirClient),
      await updateBackupExpectations(deps(), mine.owner, theirClient, hours),
    ]) {
      expect(state).toEqual({ status: "error", message: "That client no longer exists." });
    }

    expect(await asset(theirs, "sql")).toMatchObject({
      mutedUntil: null,
      expectedFrequencyHours: 24,
      slaHours: 72,
    });
    expect(await openIncidents(theirs)).toBe(3);
    expect(await audit(theirs)).toEqual([]);
    expect(await audit(mine)).toEqual([]);
  });

  it.each(["", "not-a-uuid", "' OR 1=1 --", randomUUID()])(
    "treats the id %j as not found",
    async (id) => {
      const w = await workspace();
      const mute = { duration: "7", reason: "Valid reason" };
      expect(await muteAssets(deps(), w.owner, { assetId: id }, mute)).toMatchObject({
        status: "error",
        message: "That asset no longer exists.",
      });
      expect(await unmuteAssets(deps(), w.owner, { clientId: id })).toMatchObject({
        status: "error",
        message: "That client no longer exists.",
      });
    },
  );
});
