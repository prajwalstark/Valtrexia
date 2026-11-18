import { describe, expect, it } from "vitest";
import { operatorStatus, type StatusDeps } from "./status-core";

const TOKEN = "status-token-0123456789abcdef0123456789";
const NOW = Date.parse("2026-11-20T10:00:00Z");
const beat = (secondsAgo: number) => JSON.stringify({ at: NOW - secondsAgo * 1000, startedAt: 0 });
const snapshot = (secondsAgo: number) =>
  JSON.stringify({
    at: new Date(NOW - secondsAgo * 1000).toISOString(),
    integrations: { total: 12, failing: 1, overdue: 0 },
    notifications: { overdue: 0, failedLastHour: 0 },
    maintenance: { ok: true, at: "2026-11-20T06:00:00.000Z" },
    queues: { sync: { waiting: 0, active: 1, delayed: 0, failed: 0 } },
  });

function deps(overrides: Partial<StatusDeps> = {}): StatusDeps {
  return {
    token: TOKEN,
    heartbeats: async () => [beat(10), beat(400)],
    fleetSnapshot: async () => snapshot(60),
    openAlerts: async () => [],
    now: NOW,
    checkSeconds: 300,
    ...overrides,
  };
}
const ask = (d: StatusDeps, auth: string | null = `Bearer ${TOKEN}`) => operatorStatus(auth, d);

describe("operator status", () => {
  it("does not exist without a token, or with one too short to be safe", async () => {
    expect(await ask(deps({ token: undefined }))).toEqual({ kind: "off" });
    expect(await ask(deps({ token: "short" }), "Bearer short")).toEqual({ kind: "off" });
  });

  it("reads nothing until the token checks out", async () => {
    const touched: string[] = [];
    const watching = deps({
      heartbeats: async () => (touched.push("heartbeats"), []),
      fleetSnapshot: async () => (touched.push("snapshot"), null),
      openAlerts: async () => (touched.push("alerts"), []),
    });
    await ask(deps({ ...watching, token: undefined }));
    await ask(watching, "Bearer wrong");
    expect(touched).toEqual([]);
  });

  it("refuses a missing or wrong token", async () => {
    for (const auth of [null, "", TOKEN, `Bearer ${TOKEN}x`, `bearer ${TOKEN}`]) {
      expect(await ask(deps(), auth)).toEqual({ kind: "unauthorized" });
    }
  });

  it("is ok with a live worker, a recent check and no alerts, and reports counts only", async () => {
    const result = await ask(deps());
    expect(result).toMatchObject({
      kind: "report",
      status: 200,
      body: {
        status: "ok",
        problems: [],
        workers: { alive: 1, newestHeartbeatSecondsAgo: 10 },
        fleetCheckedSecondsAgo: 60,
        fleet: { integrations: { total: 12, failing: 1, overdue: 0 } },
        openAlerts: [],
      },
    });
  });

  it("is a problem when no worker beats, the check is stale or missing, or an alert is open", async () => {
    const problems = async (d: StatusDeps) => {
      const result = await ask(d);
      if (result.kind !== "report") throw new Error("expected a report");
      expect(result.status).toBe(503);
      return result.body.problems;
    };
    expect(await problems(deps({ heartbeats: async () => [beat(120)] }))).toEqual([
      "no_worker_heartbeat",
    ]);
    expect(await problems(deps({ heartbeats: async () => [] }))).toEqual(["no_worker_heartbeat"]);
    expect(await problems(deps({ fleetSnapshot: async () => snapshot(901) }))).toEqual([
      "fleet_check_stale",
    ]);
    expect(await problems(deps({ fleetSnapshot: async () => null }))).toEqual([
      "fleet_check_stale",
    ]);
    expect(
      await problems(
        deps({
          openAlerts: async () => [{ condition: "notifications_backlog", openedAt: new Date(NOW) }],
        }),
      ),
    ).toEqual(["notifications_backlog"]);
  });
});
