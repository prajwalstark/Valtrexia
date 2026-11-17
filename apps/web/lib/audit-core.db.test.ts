import { randomUUID } from "node:crypto";
import { createDb, type Db } from "@valtrexia/db";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { muteAssets, updateBackupExpectations } from "./asset-settings-core";
import {
  AUDIT_ENTRIES_PER_PAGE,
  auditQuery,
  describeAuditEntry,
  listAuditLog,
  parseAuditFilter,
  type AuditFilter,
  type AuditNames,
} from "./audit-core";
import type { TenantSession } from "./session-core";
import { updateWorkspaceSettings } from "./workspace-core";

const urls = inject("databaseUrls");
const NOW = new Date("2026-11-12T15:00:00Z");
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

let db: Db;
beforeAll(() => {
  db = createDb({ url: urls.app });
});
afterAll(async () => {
  await db.disconnect();
});

async function workspace() {
  const tenantId = await db.provisionTenant({ clerkOrgId: `org_${randomUUID()}`, name: "MSP" });
  return db.withTenant(tenantId, async ({ tx }) => {
    const user = async (role: "owner" | "technician", name: string | null) => {
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
    const tech = await user("technician", null);
    const integration = await tx.integration.create({
      data: {
        tenantId,
        vendor: "datto_bcdr",
        name: "Datto main",
        credentialsEnc: { v: 1, ciphertext: "fixture-ciphertext-must-not-leak" },
      },
    });
    const client = await tx.client.create({ data: { tenantId, name: "Acme" } });
    const asset = await tx.asset.create({
      data: {
        tenantId,
        clientId: client.id,
        integrationId: integration.id,
        vendorAssetId: "sql",
        name: "ACME-SQL01",
        type: "agent",
      },
    });
    return {
      tenantId,
      owner,
      tech,
      integrationId: integration.id,
      assetId: asset.id,
      clientId: client.id,
    };
  });
}
type Workspace = Awaited<ReturnType<typeof workspace>>;

/** Writes an entry at a chosen time, as the app role: the log accepts inserts and nothing else. */
const write = (
  w: Workspace,
  minutes: number,
  entry: {
    action: string;
    actorUserId?: string | null;
    targetType?: string;
    targetId?: string;
    metadata?: Record<string, string | number | boolean | null>;
    ip?: string;
  },
) =>
  db.withTenant(w.tenantId, ({ tx }) =>
    tx.auditLog.create({
      data: {
        tenantId: w.tenantId,
        actorType: entry.actorUserId ? "user" : "system",
        actorUserId: entry.actorUserId ?? null,
        action: entry.action,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        metadata: entry.metadata ?? {},
        ip: entry.ip ?? null,
        createdAt: minutesAgo(minutes),
      },
    }),
  );

const filter = (overrides: Partial<AuditFilter> = {}): AuditFilter => ({
  category: "all",
  page: 1,
  ...overrides,
});
const list = async (w: Workspace, session: TenantSession, f: AuditFilter = filter()) => {
  const result = await listAuditLog({ db }, session, f);
  if (result.status !== "ok") throw new Error("expected the audit log");
  return result;
};

describe("listAuditLog", () => {
  it("is for owners only", async () => {
    const w = await workspace();
    await write(w, 1, { action: "tenant.provisioned" });
    expect(await listAuditLog({ db }, w.tech, filter())).toEqual({ status: "forbidden" });
    expect((await list(w, w.owner)).rows).toHaveLength(1);
  });

  it("lists entries newest first, with who, what and from where", async () => {
    const w = await workspace();
    await write(w, 30, { action: "tenant.provisioned" });
    await write(w, 20, {
      action: "integration.created",
      actorUserId: w.owner.userId,
      targetType: "integration",
      targetId: w.integrationId,
      metadata: { vendor: "datto_bcdr", name: "Datto main" },
      ip: "203.0.113.9",
    });
    await write(w, 10, {
      action: "incident.acknowledged",
      actorUserId: w.tech.userId,
      targetType: "incident",
      targetId: randomUUID(),
      metadata: { type: "failed", assetId: w.assetId },
      ip: "198.51.100.4",
    });

    const result = await list(w, w.owner);
    expect(result).toMatchObject({ total: 3, pageCount: 1, timeZone: "UTC" });
    expect(
      result.rows.map(({ at, actor, action, summary, ip }) => ({ at, actor, action, summary, ip })),
    ).toEqual([
      {
        at: minutesAgo(10),
        // No name on record: the email stands in.
        actor: "technician@msp.example",
        action: "incident.acknowledged",
        summary: "Acknowledged a failed incident on ACME-SQL01",
        ip: "198.51.100.4",
      },
      {
        at: minutesAgo(20),
        actor: "Olive Owner",
        action: "integration.created",
        summary: "Connected Datto main (Datto BCDR)",
        ip: "203.0.113.9",
      },
      {
        at: minutesAgo(30),
        actor: "System",
        action: "tenant.provisioned",
        summary: "Created the workspace",
        ip: null,
      },
    ]);
  });

  it("puts the real changes people make into words", async () => {
    const w = await workspace();
    await muteAssets(
      { db, now: NOW },
      w.tech,
      { assetId: w.assetId },
      { duration: "7", reason: "Being replaced" },
    );
    await updateBackupExpectations(
      { db },
      w.owner,
      { clientId: w.clientId },
      { expectedFrequencyHours: "12", slaHours: "" },
    );
    await updateWorkspaceSettings({ db }, w.owner, {
      timeZone: "America/New_York",
      graceHours: "6",
    });

    const summaries = (await list(w, w.owner)).rows.map((row) => row.summary);
    expect(summaries).toEqual(
      expect.arrayContaining([
        "Muted ACME-SQL01 until 19 Nov 2026: “Being replaced”",
        "Changed ACME-SQL01 (with all of its client’s assets): expected every 24 → 12 hours",
        "Changed the time zone from UTC to America/New York and the grace period from 2 to 6 hours",
      ]),
    );
    expect(summaries).toHaveLength(3);
  });

  it("filters by category", async () => {
    const w = await workspace();
    await write(w, 5, { action: "asset.unmuted", targetType: "asset", targetId: w.assetId });
    await write(w, 4, {
      action: "integration.deleted",
      metadata: { name: "Old", assetsRemoved: 3 },
    });
    await write(w, 3, { action: "user.deactivated", targetType: "user", targetId: w.tech.userId });
    await write(w, 2, { action: "tenant.provisioned" });
    await write(w, 1, { action: "workspace.settings_changed" });

    const actions = async (category: AuditFilter["category"]) =>
      (await list(w, w.owner, filter({ category }))).rows.map((row) => row.action);
    expect(await actions("all")).toHaveLength(5);
    expect(await actions("assets")).toEqual(["asset.unmuted"]);
    expect(await actions("integrations")).toEqual(["integration.deleted"]);
    expect(await actions("people")).toEqual(["user.deactivated"]);
    expect(await actions("incidents")).toEqual([]);
    expect(await actions("workspace")).toEqual([
      "workspace.settings_changed",
      "tenant.provisioned",
    ]);
  });

  it("pages through every entry exactly once, and clamps a page beyond the last", async () => {
    const w = await workspace();
    await db.withTenant(w.tenantId, ({ tx }) =>
      tx.auditLog.createMany({
        data: Array.from({ length: AUDIT_ENTRIES_PER_PAGE + 7 }, (_, index) => ({
          tenantId: w.tenantId,
          actorType: "system" as const,
          action: "asset.unmuted",
          // Pairs share a timestamp, to exercise the tie-break.
          createdAt: minutesAgo(Math.floor(index / 2)),
        })),
      }),
    );
    const first = await list(w, w.owner, filter({ page: 1 }));
    const second = await list(w, w.owner, filter({ page: 2 }));
    expect(first).toMatchObject({ total: 57, pageCount: 2 });
    expect(first.rows).toHaveLength(AUDIT_ENTRIES_PER_PAGE);
    expect(second.rows).toHaveLength(7);
    expect(new Set([...first.rows, ...second.rows].map((row) => row.id)).size).toBe(57);

    const beyond = await list(w, w.owner, filter({ page: 40 }));
    expect(beyond.filter.page).toBe(2);
  });

  it("shows a workspace only its own log", async () => {
    const mine = await workspace();
    const theirs = await workspace();
    await write(theirs, 1, { action: "integration.deleted", metadata: { name: "Theirs" } });
    expect((await list(mine, mine.owner)).rows).toEqual([]);
    expect((await list(theirs, theirs.owner)).rows).toHaveLength(1);
  });

  it("contains no credentials", async () => {
    const w = await workspace();
    await write(w, 1, {
      action: "integration.credentials_replaced",
      actorUserId: w.owner.userId,
      targetType: "integration",
      targetId: w.integrationId,
      metadata: { vendor: "datto_bcdr" },
    });
    const result = await list(w, w.owner);
    expect(result.rows[0]!.summary).toBe("Replaced the keys of Datto main");
    expect(JSON.stringify(result)).not.toContain("fixture-ciphertext-must-not-leak");
  });

  it("the log cannot be edited or erased, even by the code that reads it", async () => {
    const w = await workspace();
    const entry = await write(w, 1, { action: "tenant.provisioned" });
    await expect(
      db.withTenant(w.tenantId, ({ tx }) =>
        tx.auditLog.update({ where: { id: entry.id }, data: { action: "rewritten" } }),
      ),
    ).rejects.toThrow();
    await expect(
      db.withTenant(w.tenantId, ({ tx }) => tx.auditLog.delete({ where: { id: entry.id } })),
    ).rejects.toThrow();
  });
});

describe("describeAuditEntry", () => {
  const ASSET = randomUUID();
  const INTEGRATION = randomUUID();
  const USER = randomUUID();
  const names: AuditNames = {
    assets: new Map([[ASSET, "ACME-SQL01"]]),
    integrations: new Map([[INTEGRATION, "Datto main"]]),
    users: new Map([[USER, "Terry Tech"]]),
  };
  const say = (action: string, targetId: string | null, metadata: unknown, zone = "UTC") =>
    describeAuditEntry({ action, targetId, metadata }, names, zone);

  it("describes mutes: dated, open-ended, for a whole client, and what they closed", () => {
    const dated = {
      until: "2026-11-19T15:00:00.000Z",
      indefinite: false,
      reason: "Works",
      incidentsClosed: 2,
    };
    expect(say("asset.muted", ASSET, dated)).toBe(
      "Muted ACME-SQL01 until 19 Nov 2026: “Works”. 2 open incidents closed",
    );
    // The same moment is the 20th at UTC+14.
    expect(say("asset.muted", ASSET, dated, "Pacific/Kiritimati")).toContain("until 20 Nov 2026");
    expect(
      say("asset.muted", ASSET, { until: null, indefinite: true, reason: "Retired", bulk: true }),
    ).toBe("Muted ACME-SQL01 with no end date (with all of its client’s assets): “Retired”");
    expect(say("asset.unmuted", ASSET, { bulk: false })).toBe("Unmuted ACME-SQL01");
  });

  it("describes only the expectations that changed", () => {
    const change = (from: object, to: object) =>
      say("asset.expectations_changed", ASSET, { from, to });
    expect(
      change(
        { expectedFrequencyHours: 24, slaHours: 72 },
        { expectedFrequencyHours: 12, slaHours: 48 },
      ),
    ).toBe("Changed ACME-SQL01: expected every 24 → 12 hours, SLA 72 → 48 hours");
    expect(
      change(
        { expectedFrequencyHours: 24, slaHours: 72 },
        { expectedFrequencyHours: 24, slaHours: 96 },
      ),
    ).toBe("Changed ACME-SQL01: SLA 72 → 96 hours");
  });

  it("describes integrations", () => {
    expect(
      say("integration.created", INTEGRATION, { vendor: "datto_bcdr", name: "Datto main" }),
    ).toBe("Connected Datto main (Datto BCDR)");
    // The vendor is not repeated when the integration is simply named after it.
    expect(
      say("integration.created", INTEGRATION, { vendor: "datto_bcdr", name: "Datto BCDR" }),
    ).toBe("Connected Datto BCDR");
    expect(say("integration.credentials_replaced", INTEGRATION, { vendor: "datto_bcdr" })).toBe(
      "Replaced the keys of Datto main",
    );
    expect(say("integration.deleted", randomUUID(), { name: "Old Datto", assetsRemoved: 1 })).toBe(
      "Disconnected Old Datto, removing 1 asset and their history",
    );
    expect(say("integration.connection_tested", INTEGRATION, { outcome: "rejected" })).toBe(
      "Tested the connection to Datto main: the vendor rejected the keys",
    );
    expect(
      say("integration.connection_tested", null, { vendor: "datto_bcdr", outcome: "ok" }),
    ).toBe("Tested new Datto BCDR keys before saving them: it succeeded");
  });

  it("describes people and the workspace", () => {
    expect(say("user.joined", USER, { role: "technician" })).toBe(
      "Terry Tech joined as technician",
    );
    expect(say("user.role_changed", USER, { from: "technician", to: "owner" })).toBe(
      "Terry Tech changed from technician to owner",
    );
    expect(say("user.deactivated", USER, {})).toBe("Terry Tech was removed from the workspace");
    expect(say("user.reactivated", USER, { role: "owner" })).toBe("Terry Tech rejoined as owner");
    expect(
      say("workspace.settings_changed", null, {
        from: { timeZone: "UTC", graceHours: 2 },
        to: { timeZone: "UTC", graceHours: 1 },
      }),
    ).toBe("Changed the grace period from 2 to 1 hour");
  });

  it("says so when the thing an entry is about has since been removed", () => {
    const gone = randomUUID();
    expect(say("asset.unmuted", gone, {})).toBe("Unmuted an asset since removed");
    expect(say("integration.credentials_replaced", gone, {})).toBe(
      "Replaced the keys of an integration since removed",
    );
    expect(say("user.deactivated", gone, {})).toBe(
      "someone since removed was removed from the workspace",
    );
    expect(say("incident.acknowledged", gone, { type: "missed", assetId: gone })).toBe(
      "Acknowledged a missed incident on an asset since removed",
    );
  });

  it("shows an action it does not know by its stored name, and survives odd metadata", () => {
    expect(say("billing.plan_changed", null, { plan: "pro" })).toBe("billing.plan_changed");
    for (const metadata of [null, "text", 7, [], { until: 5, reason: {}, from: "x", to: [] }]) {
      for (const action of [
        "asset.muted",
        "asset.expectations_changed",
        "workspace.settings_changed",
      ]) {
        expect(typeof say(action, ASSET, metadata)).toBe("string");
      }
    }
  });
});

describe("parseAuditFilter and auditQuery", () => {
  it("reads a query and falls back to the default for anything unrecognized", () => {
    expect(parseAuditFilter({ category: "assets", page: "2" })).toEqual({
      category: "assets",
      page: 2,
    });
    expect(parseAuditFilter({})).toEqual({ category: "all", page: 1 });
    expect(parseAuditFilter({ category: "constructor", page: "0" })).toEqual({
      category: "all",
      page: 1,
    });
    expect(parseAuditFilter({ category: "__proto__" }).category).toBe("all");
  });

  it("writes links that leave out defaults", () => {
    expect(auditQuery({})).toBe("/audit");
    expect(auditQuery({ category: "people", page: 3 })).toBe("/audit?category=people&page=3");
  });
});
