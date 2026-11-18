import { randomUUID } from "node:crypto";
import { createDb, type Db } from "@valtrexia/db";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  incidentQuery,
  INCIDENTS_PER_PAGE,
  listIncidents,
  parseIncidentFilter,
  type IncidentFilter,
  type IncidentKind,
} from "./incidents-core";
import type { TenantSession } from "./session-core";

const urls = inject("databaseUrls");
const HOUR = 3_600_000;
const NOW = new Date("2026-11-12T15:00:00Z");
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR);

let db: Db;
beforeAll(() => {
  db = createDb({ url: urls.app });
});
afterAll(async () => {
  await db.disconnect();
});

interface Spec {
  client: string;
  asset: string;
  type: IncidentKind;
  openedHoursAgo: number;
  acknowledged?: boolean;
  closedHoursAgo?: number;
}

async function workspace(specs: Spec[], extraClients: string[] = []) {
  const tenantId = await db.provisionTenant({ clerkOrgId: `org_${randomUUID()}`, name: "MSP" });
  return db.withTenant(tenantId, async ({ tx }) => {
    const user = await tx.user.create({
      data: {
        tenantId,
        clerkUserId: `user_${randomUUID()}`,
        email: "tech@msp.example",
        name: "Terry Tech",
        role: "technician",
      },
    });
    const integration = await tx.integration.create({
      data: { tenantId, vendor: "mock", name: "Demo data", credentialsEnc: { v: 1 } },
    });
    const clients: Record<string, string> = {};
    const assets: Record<string, string> = {};
    for (const name of extraClients) {
      clients[name] = (await tx.client.create({ data: { tenantId, name } })).id;
    }
    for (const spec of specs) {
      clients[spec.client] ??= (
        await tx.client.create({ data: { tenantId, name: spec.client } })
      ).id;
      const key = `${spec.client}/${spec.asset}`;
      assets[key] ??= (
        await tx.asset.create({
          data: {
            tenantId,
            clientId: clients[spec.client]!,
            integrationId: integration.id,
            vendorAssetId: key,
            name: spec.asset,
            type: "agent",
          },
        })
      ).id;
      await tx.incident.create({
        data: {
          tenantId,
          assetId: assets[key]!,
          type: spec.type,
          openedAt: ago(spec.openedHoursAgo),
          closedAt: spec.closedHoursAgo === undefined ? null : ago(spec.closedHoursAgo),
          ...(spec.acknowledged
            ? { acknowledgedAt: ago(spec.openedHoursAgo - 0.5), acknowledgedByUserId: user.id }
            : {}),
        },
      });
    }
    const session: TenantSession = {
      tenantId,
      userId: user.id,
      clerkUserId: user.clerkUserId,
      role: "technician",
    };
    return { session, clients };
  });
}

const filter = (overrides: Partial<IncidentFilter> = {}): IncidentFilter => ({
  view: "attention",
  clientId: null,
  type: null,
  page: 1,
  ...overrides,
});
const labels = (rows: { clientName: string; assetName: string; type: string }[]) =>
  rows.map((row) => `${row.clientName}/${row.assetName}:${row.type}`);

const MIXED: Spec[] = [
  { client: "Acme", asset: "sql", type: "failed", openedHoursAgo: 30 },
  { client: "Acme", asset: "sql", type: "missed", openedHoursAgo: 10 },
  { client: "Acme", asset: "sql", type: "stale", openedHoursAgo: 2 },
  { client: "Acme", asset: "fs", type: "missed", openedHoursAgo: 50, acknowledged: true },
  { client: "Birch", asset: "web", type: "failed", openedHoursAgo: 5 },
  { client: "Birch", asset: "web", type: "failed", openedHoursAgo: 90, closedHoursAgo: 80 },
  { client: "Birch", asset: "db", type: "missed", openedHoursAgo: 70, closedHoursAgo: 3 },
];

describe("listIncidents: the three views", () => {
  it("lists open, unacknowledged incidents oldest first", async () => {
    const { session } = await workspace(MIXED);
    const list = await listIncidents({ db }, session, filter());
    expect(labels(list.rows)).toEqual([
      "Acme/sql:failed",
      "Acme/sql:missed",
      "Birch/web:failed",
      "Acme/sql:stale",
    ]);
    expect(list).toMatchObject({
      total: 4,
      pageCount: 1,
      timeZone: "UTC",
      counts: { attention: 4, acknowledged: 1, closed: 2 },
    });
    expect(list.rows[0]).toMatchObject({
      openedAt: ago(30),
      closedAt: null,
      acknowledgedAt: null,
      acknowledgedBy: null,
    });
  });

  it("lists acknowledged incidents with who acknowledged them", async () => {
    const { session } = await workspace(MIXED);
    const list = await listIncidents({ db }, session, filter({ view: "acknowledged" }));
    expect(labels(list.rows)).toEqual(["Acme/fs:missed"]);
    expect(list.rows[0]).toMatchObject({ acknowledgedBy: "Terry Tech", acknowledgedAt: ago(49.5) });
  });

  it("lists closed incidents by when they closed, most recent first", async () => {
    const { session } = await workspace(MIXED);
    const list = await listIncidents({ db }, session, filter({ view: "closed" }));
    expect(labels(list.rows)).toEqual(["Birch/db:missed", "Birch/web:failed"]);
    expect(list.rows[0]!.closedAt).toEqual(ago(3));
  });

  it("is empty, not an error, for a workspace with no incidents", async () => {
    const { session } = await workspace([], ["Calm Co"]);
    const list = await listIncidents({ db }, session, filter());
    expect(list).toMatchObject({
      rows: [],
      total: 0,
      pageCount: 1,
      counts: { attention: 0, acknowledged: 0, closed: 0 },
      clients: [{ name: "Calm Co" }],
    });
  });
});

describe("listIncidents: filters", () => {
  it("filters by client, and the counts follow", async () => {
    const { session, clients } = await workspace(MIXED);
    const list = await listIncidents({ db }, session, filter({ clientId: clients.Birch! }));
    expect(labels(list.rows)).toEqual(["Birch/web:failed"]);
    expect(list.counts).toEqual({ attention: 1, acknowledged: 0, closed: 2 });
    expect(list.filter.clientId).toBe(clients.Birch);
  });

  it("filters by type, and by both at once", async () => {
    const { session, clients } = await workspace(MIXED);
    const missed = await listIncidents({ db }, session, filter({ type: "missed" }));
    expect(labels(missed.rows)).toEqual(["Acme/sql:missed"]);
    expect(missed.counts).toEqual({ attention: 1, acknowledged: 1, closed: 1 });

    const both = await listIncidents(
      { db },
      session,
      filter({ type: "failed", clientId: clients.Acme! }),
    );
    expect(labels(both.rows)).toEqual(["Acme/sql:failed"]);
  });

  it("lists every client for the filter, by name, including ones with no incidents", async () => {
    const { session } = await workspace(MIXED, ["Zephyr", "Aardvark"]);
    const list = await listIncidents({ db }, session, filter());
    expect(list.clients.map((client) => client.name)).toEqual([
      "Aardvark",
      "Acme",
      "Birch",
      "Zephyr",
    ]);
  });
});

describe("listIncidents: pages", () => {
  const many: Spec[] = Array.from({ length: INCIDENTS_PER_PAGE * 2 + 5 }, (_, index) => ({
    client: "Big Co",
    asset: `asset-${String(index).padStart(3, "0")}`,
    type: "failed" as const,
    // Half of them opened at the very same moment, to exercise the tie-break.
    openedHoursAgo: index % 2 === 0 ? 100 : 100 - index / 10,
  }));

  it("pages through every incident exactly once", async () => {
    const { session } = await workspace(many);
    const seen: string[] = [];
    for (const page of [1, 2, 3]) {
      const list = await listIncidents({ db }, session, filter({ page }));
      expect(list).toMatchObject({ total: 105, pageCount: 3, filter: { page } });
      expect(list.rows).toHaveLength(page === 3 ? 5 : INCIDENTS_PER_PAGE);
      seen.push(...list.rows.map((row) => row.id));
    }
    expect(new Set(seen).size).toBe(105);
  });

  it("shows the last page when asked for one beyond it", async () => {
    const { session } = await workspace(many);
    const list = await listIncidents({ db }, session, filter({ page: 99 }));
    expect(list.filter.page).toBe(3);
    expect(list.rows).toHaveLength(5);
  });
});

describe("listIncidents: tenants", () => {
  it("shows a workspace only its own incidents and clients", async () => {
    const mine = await workspace([
      { client: "Mine", asset: "a", type: "failed", openedHoursAgo: 1 },
    ]);
    const theirs = await workspace(MIXED);

    const list = await listIncidents({ db }, mine.session, filter());
    expect(labels(list.rows)).toEqual(["Mine/a:failed"]);
    expect(list.clients.map((client) => client.name)).toEqual(["Mine"]);
    for (const view of ["acknowledged", "closed"] as const) {
      expect((await listIncidents({ db }, mine.session, filter({ view }))).rows).toEqual([]);
    }

    // Asking for another workspace's client is the same as not filtering.
    const sneaky = await listIncidents(
      { db },
      mine.session,
      filter({ clientId: theirs.clients.Acme! }),
    );
    expect(sneaky.filter.clientId).toBeNull();
    expect(labels(sneaky.rows)).toEqual(["Mine/a:failed"]);
  });
});

describe("parseIncidentFilter and incidentQuery", () => {
  it("reads a well-formed query", () => {
    const id = randomUUID();
    expect(parseIncidentFilter({ view: "closed", type: "stale", client: id, page: "3" })).toEqual({
      view: "closed",
      type: "stale",
      clientId: id,
      page: 3,
    });
  });

  it("falls back to the default for anything it does not recognize", () => {
    const fallback = { view: "attention", type: null, clientId: null, page: 1 };
    expect(parseIncidentFilter({})).toEqual(fallback);
    expect(
      parseIncidentFilter({
        view: "everything",
        type: "exploded",
        client: "' OR 1=1 --",
        page: "-2",
      }),
    ).toEqual(fallback);
    for (const page of ["0", "1.5", "abc", "1e9", ""]) {
      expect(parseIncidentFilter({ page }).page).toBe(1);
    }
    // A repeated parameter takes its first value.
    expect(parseIncidentFilter({ view: ["closed", "attention"] }).view).toBe("closed");
  });

  it("writes links that leave out defaults and read back the same", () => {
    expect(incidentQuery({})).toBe("/incidents");
    expect(incidentQuery(filter())).toBe("/incidents");
    const id = randomUUID();
    const full = filter({ view: "acknowledged", type: "missed", clientId: id, page: 2 });
    const link = incidentQuery(full);
    expect(link).toBe(`/incidents?view=acknowledged&client=${id}&type=missed&page=2`);
    const params = Object.fromEntries(new URLSearchParams(link.split("?")[1]));
    expect(parseIncidentFilter(params)).toEqual(full);
  });
});
