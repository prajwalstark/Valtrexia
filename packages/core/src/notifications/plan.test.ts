import { describe, expect, it } from "vitest";
import {
  buildIncidentsPayload,
  buildIntegrationHealthPayload,
  changesForChannel,
  channelsForIntegrationHealth,
  MAX_CHANGES_PER_MESSAGE,
  MAX_DELIVERY_ATTEMPTS,
  nextAttemptAt,
  planIncidentMessages,
  type ChannelPreferences,
  type IncidentChange,
} from "./plan";

const NOW = new Date("2026-11-12T12:00:00Z");
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);

const channel = (overrides: Partial<ChannelPreferences> = {}): ChannelPreferences => ({
  id: "ch1",
  enabled: true,
  incidentTypes: ["failed", "missed", "stale"],
  notifyOpened: true,
  notifyClosed: true,
  notifyIntegrationHealth: true,
  ...overrides,
});

let next = 0;
const change = (overrides: Partial<IncidentChange> = {}): IncidentChange => {
  next += 1;
  const event = overrides.event ?? "opened";
  return {
    incidentId: `inc-${next}`,
    type: "failed",
    event,
    reason: event === "closed" ? "resolved" : null,
    client: { id: "c1", name: "Acme" },
    asset: { id: `a-${next}`, name: `SRV${next}` },
    openedAt: hoursAgo(2),
    closedAt: event === "closed" ? NOW : null,
    lastBackupAt: hoursAgo(30),
    ...overrides,
  };
};

describe("changesForChannel", () => {
  it("passes everything to a channel that wants everything", () => {
    const changes = [change(), change({ event: "closed" }), change({ type: "stale" })];
    expect(changesForChannel(channel(), changes)).toHaveLength(3);
  });

  it("tells a disabled channel nothing", () => {
    expect(changesForChannel(channel({ enabled: false }), [change()])).toEqual([]);
  });

  it("keeps to the incident types a channel chose", () => {
    const changes = [
      change({ type: "failed" }),
      change({ type: "missed" }),
      change({ type: "stale" }),
    ];
    const picked = changesForChannel(channel({ incidentTypes: ["stale"] }), changes);
    expect(picked.map((c) => c.type)).toEqual(["stale"]);
  });

  it("keeps to the events a channel chose", () => {
    const changes = [change({ event: "opened" }), change({ event: "closed" })];
    expect(
      changesForChannel(channel({ notifyClosed: false }), changes).map((c) => c.event),
    ).toEqual(["opened"]);
    expect(
      changesForChannel(channel({ notifyOpened: false }), changes).map((c) => c.event),
    ).toEqual(["closed"]);
  });

  it("never reports an incident closed because someone muted or paused the asset", () => {
    const changes = [
      change({ event: "closed", reason: "suppressed" }),
      change({ event: "closed", reason: "resolved" }),
    ];
    expect(changesForChannel(channel(), changes).map((c) => c.reason)).toEqual(["resolved"]);
  });

  it("orders by client, then asset, then type, whatever order they came in", () => {
    const changes = [
      change({ client: { id: "c2", name: "Birch" }, asset: { id: "x", name: "SRV10" } }),
      change({
        client: { id: "c1", name: "acme" },
        asset: { id: "y", name: "SRV9" },
        type: "missed",
      }),
      change({
        client: { id: "c1", name: "acme" },
        asset: { id: "y", name: "SRV9" },
        type: "failed",
      }),
      change({ client: { id: "c1", name: "acme" }, asset: { id: "z", name: "SRV10" } }),
    ];
    expect(
      changesForChannel(channel(), changes).map(
        (c) => `${c.client.name}/${c.asset.name}/${c.type}`,
      ),
    ).toEqual(["acme/SRV9/failed", "acme/SRV9/missed", "acme/SRV10/failed", "Birch/SRV10/failed"]);
  });
});

describe("planIncidentMessages", () => {
  it("sends each channel one message with everything it wants, and none to a channel that wants nothing", () => {
    const changes = [
      change({ type: "failed" }),
      change({ type: "missed" }),
      change({ type: "stale" }),
    ];
    const plan = planIncidentMessages(
      [
        channel({ id: "all" }),
        channel({ id: "stale-only", incidentTypes: ["stale"] }),
        channel({ id: "off", enabled: false }),
        channel({ id: "closed-only", notifyOpened: false }),
      ],
      changes,
    );
    expect(plan.map((m) => [m.channelId, m.changes.length])).toEqual([
      ["all", 3],
      ["stale-only", 1],
    ]);
  });

  it("is one message for a whole outage, not one per asset", () => {
    const outage = Array.from({ length: 40 }, () => change({ type: "missed" }));
    const plan = planIncidentMessages([channel()], outage);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.changes).toHaveLength(40);
  });

  it("splits a very large run into messages of at most the limit, losing nothing", () => {
    const huge = Array.from({ length: MAX_CHANGES_PER_MESSAGE * 2 + 3 }, () => change());
    const plan = planIncidentMessages([channel()], huge);
    expect(plan.map((m) => m.changes.length)).toEqual([
      MAX_CHANGES_PER_MESSAGE,
      MAX_CHANGES_PER_MESSAGE,
      3,
    ]);
    expect(new Set(plan.flatMap((m) => m.changes.map((c) => c.incidentId))).size).toBe(huge.length);
  });

  it("plans nothing when nothing changed", () => {
    expect(planIncidentMessages([channel()], [])).toEqual([]);
  });
});

describe("channelsForIntegrationHealth", () => {
  it("picks the enabled channels that asked for it", () => {
    const picked = channelsForIntegrationHealth([
      channel({ id: "yes" }),
      channel({ id: "no", notifyIntegrationHealth: false }),
      channel({ id: "off", enabled: false }),
    ]);
    expect(picked.map((c) => c.id)).toEqual(["yes"]);
  });
});

describe("messages", () => {
  it("lists opened and closed incidents with names and times, and nothing else", () => {
    const payload = buildIncidentsPayload({
      workspaceName: "Northwind IT",
      at: NOW,
      changes: [
        change({ incidentId: "i1", type: "missed", asset: { id: "a1", name: "SQL01" } }),
        change({ incidentId: "i2", event: "closed", asset: { id: "a2", name: "FS01" } }),
      ],
    });
    expect(payload).toEqual({
      type: "incidents.changed",
      version: 1,
      timestamp: "2026-11-12T12:00:00.000Z",
      data: {
        workspace: { name: "Northwind IT" },
        opened: [
          {
            incidentId: "i1",
            type: "missed",
            client: { id: "c1", name: "Acme" },
            asset: { id: "a1", name: "SQL01" },
            openedAt: "2026-11-12T10:00:00.000Z",
            closedAt: null,
            lastBackupAt: "2026-11-11T06:00:00.000Z",
          },
        ],
        closed: [
          expect.objectContaining({
            incidentId: "i2",
            closedAt: "2026-11-12T12:00:00.000Z",
          }) as unknown,
        ],
      },
    });
    // Survives serialization unchanged: what is stored is what is sent.
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });

  it("describes an integration that became unhealthy, and one that recovered without the old error", () => {
    const base = {
      workspaceName: "Northwind IT",
      at: NOW,
      integration: { id: "int1", name: "Datto main", vendor: "datto_bcdr" },
      failingSince: hoursAgo(1),
      error: "The vendor rejected these credentials.",
      needsAction: true,
    };
    expect(buildIntegrationHealthPayload({ ...base, state: "unhealthy" }).data).toEqual({
      workspace: { name: "Northwind IT" },
      integration: { id: "int1", name: "Datto main", vendor: "datto_bcdr" },
      failingSince: "2026-11-12T11:00:00.000Z",
      error: "The vendor rejected these credentials.",
      needsAction: true,
    });
    const recovered = buildIntegrationHealthPayload({ ...base, state: "recovered" });
    expect(recovered.type).toBe("integration.recovered");
    expect(recovered.data).toMatchObject({ error: null, needsAction: false });
  });
});

describe("nextAttemptAt", () => {
  it("backs off between attempts, then gives up", () => {
    const minutesLater = (attempts: number) => {
      const at = nextAttemptAt(attempts, NOW);
      return at === null ? null : (at.getTime() - NOW.getTime()) / 60_000;
    };
    expect([1, 2, 3, 4, 5, 6, 7].map(minutesLater)).toEqual([1, 5, 15, 30, 60, 120, 240]);
    expect(MAX_DELIVERY_ATTEMPTS).toBe(8);
    expect(minutesLater(8)).toBeNull();
    expect(minutesLater(20)).toBeNull();
  });
});
