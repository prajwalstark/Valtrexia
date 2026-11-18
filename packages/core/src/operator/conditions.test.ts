import { describe, expect, it } from "vitest";
import { brand } from "../brand";
import { evaluateFleet, renderOperatorAlert, type FleetSnapshot } from "./conditions";
import { operatorAlertConfigFromEnv } from "./config";
import { heartbeatAt, isHeartbeatFresh } from "./keys";

const healthy: FleetSnapshot = {
  at: "2026-11-20T10:00:00.000Z",
  integrations: { total: 40, failing: 0, overdue: 0 },
  notifications: { overdue: 0, failedLastHour: 0 },
  maintenance: { ok: true, at: "2026-11-20T06:00:00.000Z" },
  queues: {},
};
const active = (snapshot: FleetSnapshot) =>
  evaluateFleet(snapshot)
    .filter((state) => state.active)
    .map((state) => state.condition);

describe("fleet conditions", () => {
  it("raises nothing for a healthy fleet, or one whose maintenance has not run yet", () => {
    expect(active(healthy)).toEqual([]);
    expect(active({ ...healthy, maintenance: null })).toEqual([]);
  });

  it("calls failing syncs an outage only above a quarter of integrations, and at least four", () => {
    const failing = (failing: number, total: number) =>
      active({ ...healthy, integrations: { total, failing, overdue: 0 } });
    expect(failing(3, 4)).toEqual([]); // 75%, but only three
    expect(failing(4, 16)).toEqual([]); // exactly 25%
    expect(failing(5, 16)).toEqual(["integrations_failing"]);
    expect(failing(4, 4)).toEqual(["integrations_failing"]);
    expect(failing(0, 0)).toEqual([]);
  });

  it("raises overdue integrations, given-up messages, a backlog over 100 and failed maintenance", () => {
    expect(active({ ...healthy, integrations: { total: 40, failing: 0, overdue: 1 } })).toEqual([
      "integrations_overdue",
    ]);
    expect(active({ ...healthy, notifications: { overdue: 0, failedLastHour: 1 } })).toEqual([
      "notifications_failing",
    ]);
    expect(active({ ...healthy, notifications: { overdue: 100, failedLastHour: 0 } })).toEqual([]);
    expect(active({ ...healthy, notifications: { overdue: 101, failedLastHour: 0 } })).toEqual([
      "notifications_backlog",
    ]);
    expect(active({ ...healthy, maintenance: { ok: false, at: healthy.at } })).toEqual([
      "maintenance_failing",
    ]);
  });

  it("reports every condition's numbers, active or not", () => {
    const states = evaluateFleet({
      ...healthy,
      integrations: { total: 20, failing: 7, overdue: 2 },
    });
    expect(states.map((s) => s.condition)).toHaveLength(5);
    expect(states[0]).toEqual({
      condition: "integrations_failing",
      active: true,
      details: { failing: 7, total: 20 },
    });
  });
});

describe("operator alert messages", () => {
  const alert = {
    condition: "integrations_failing" as const,
    details: { failing: 7, total: 20 },
    openedAt: new Date("2026-11-20T10:00:00Z"),
    closedAt: null,
  };

  it("says what happened, with the numbers and what to check", () => {
    const message = renderOperatorAlert(alert, "opened");
    expect(message.subject).toBe(
      `[${brand.name} operator] Syncs are failing across many workspaces`,
    );
    expect(message.text).toContain("7 of 20 integrations failed their last sync.");
    expect(message.text).toContain("Check the worker's log");
    expect(message.json).toMatchObject({
      type: "operator_alert.opened",
      condition: "integrations_failing",
      details: { failing: 7, total: 20 },
      closedAt: null,
    });
    // What Slack shows.
    expect(message.json.text).toContain("7 of 20");
  });

  it("says when it cleared", () => {
    const message = renderOperatorAlert(
      { ...alert, closedAt: new Date("2026-11-20T11:30:00Z") },
      "closed",
    );
    expect(message.subject).toContain("Resolved: Syncs are failing");
    expect(message.text).toContain("cleared at 2026-11-20T11:30:00.000Z");
    expect(message.json.type).toBe("operator_alert.closed");
  });
});

describe("operator alert settings", () => {
  it("reads addresses, a webhook and its secret", () => {
    expect(
      operatorAlertConfigFromEnv({
        OPERATOR_ALERT_EMAIL: " Ops@MSP.example , oncall@msp.example,ops@msp.example ",
        OPERATOR_ALERT_WEBHOOK_URL: "https://hooks.slack.com/services/T0/B0/xyz",
        OPERATOR_ALERT_WEBHOOK_SECRET: `whsec_${"A".repeat(43)}=`,
      }),
    ).toEqual({
      emails: ["ops@msp.example", "oncall@msp.example"],
      webhookUrl: "https://hooks.slack.com/services/T0/B0/xyz",
      webhookSecret: `whsec_${"A".repeat(43)}=`,
    });
    expect(operatorAlertConfigFromEnv({})).toEqual({
      emails: [],
      webhookUrl: null,
      webhookSecret: null,
    });
  });

  it.each([
    [{ OPERATOR_ALERT_EMAIL: "not-an-address" }, /OPERATOR_ALERT_EMAIL/],
    [{ OPERATOR_ALERT_WEBHOOK_URL: "http://hooks.example.com/x" }, /https/],
    [
      { OPERATOR_ALERT_WEBHOOK_URL: "https://user:pw@hooks.example.com/x" },
      /user name or password/,
    ],
    [
      {
        OPERATOR_ALERT_WEBHOOK_URL: "https://h.example/x",
        OPERATOR_ALERT_WEBHOOK_SECRET: "secret",
      },
      /whsec_/,
    ],
    [
      { OPERATOR_ALERT_WEBHOOK_SECRET: `whsec_${"A".repeat(43)}=` },
      /without OPERATOR_ALERT_WEBHOOK_URL/,
    ],
  ])("refuses %j, without repeating it", (env, message) => {
    try {
      operatorAlertConfigFromEnv(env);
      expect.unreachable();
    } catch (error) {
      expect(String(error)).toMatch(message);
      expect(String(error)).not.toContain("pw@");
    }
  });
});

describe("heartbeats", () => {
  it("reads the time of a beat, and nothing from what is not one", () => {
    expect(heartbeatAt(JSON.stringify({ at: 5, startedAt: 1 }))).toBe(5);
    for (const value of [null, "", "{}", "nope", '{"at":"5"}'])
      expect(heartbeatAt(value)).toBeNull();
    expect(isHeartbeatFresh(JSON.stringify({ at: 1_000_000 }), 1_000_000 + 89_000)).toBe(true);
  });
});
