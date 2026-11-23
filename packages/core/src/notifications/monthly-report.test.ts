import { describe, expect, it } from "vitest";
import { brand } from "../brand";
import type { ClientMonthReport } from "../reports/client-month";
import { MAX_EMAIL_REPORT_CLIENTS, renderNotificationEmail } from "./email";
import { buildMonthlyReportPayload, channelsForMonthlyReport, MAX_REPORT_CLIENTS } from "./plan";

const AT = new Date("2026-11-01T06:00:00Z");

/** Just the parts of a report the summary reads. */
function report(
  assets: number,
  onSchedule: number | null,
  withinSla: number | null,
  backups = { completed: 30, failed: 0 },
  opened = 0,
): ClientMonthReport {
  return {
    month: "2026-10",
    partial: false,
    days: [],
    assets: [],
    excluded: [],
    summary: { assets, onSchedule, withinSla, backups },
    incidents: {
      opened: { failed: opened, missed: 0, stale: 0 },
      closed: { failed: 0, missed: 0, stale: 0 },
      medianHoursToClose: null,
    },
  };
}

const client = (id: string, name: string) => ({ id, name });

describe("buildMonthlyReportPayload", () => {
  it("lists clients least reliable first, leaves out those with nothing counted, and weights totals by asset", () => {
    const payload = buildMonthlyReportPayload({
      workspaceName: "Northwind IT",
      at: AT,
      month: "2026-10",
      reports: [
        { client: client("c1", "Acme"), report: report(3, 1, 1) },
        {
          client: client("c2", "Bravo"),
          report: report(1, 0.5, 0.75, { completed: 15, failed: 4 }, 2),
        },
        {
          client: client("c3", "Empty"),
          report: report(0, null, null, { completed: 0, failed: 0 }),
        },
      ],
    });
    expect(payload.type).toBe("report.monthly");
    expect(payload.data.clients.map((c) => c.name)).toEqual(["Bravo", "Acme"]);
    expect(payload.data.clients[0]).toEqual({
      id: "c2",
      name: "Bravo",
      assets: 1,
      onSchedule: 0.5,
      withinSla: 0.75,
      backups: { completed: 15, failed: 4 },
      incidentsOpened: 2,
    });
    expect(payload.data.totals).toEqual({
      clients: 2,
      assets: 4,
      onSchedule: (3 * 1 + 0.5) / 4,
      withinSla: (3 * 1 + 0.75) / 4,
      backups: { completed: 45, failed: 4 },
      incidentsOpened: 2,
    });
    expect(payload.data.omittedClients).toBe(0);
  });

  it("caps the list, keeping the totals whole", () => {
    const reports = Array.from({ length: MAX_REPORT_CLIENTS + 3 }, (_, i) => ({
      client: client(`c${i}`, `Client ${i}`),
      report: report(1, 1, 1),
    }));
    const payload = buildMonthlyReportPayload({
      workspaceName: "W",
      at: AT,
      month: "2026-10",
      reports,
    });
    expect(payload.data.clients).toHaveLength(MAX_REPORT_CLIENTS);
    expect(payload.data.omittedClients).toBe(3);
    expect(payload.data.totals.clients).toBe(MAX_REPORT_CLIENTS + 3);
  });
});

describe("channelsForMonthlyReport", () => {
  it("picks enabled channels that want the summary", () => {
    const base = {
      incidentTypes: [],
      notifyOpened: true,
      notifyClosed: true,
      notifyIntegrationHealth: true,
    };
    const chosen = channelsForMonthlyReport([
      { ...base, id: "yes", enabled: true, notifyMonthlyReport: true },
      { ...base, id: "off", enabled: false, notifyMonthlyReport: true },
      { ...base, id: "no", enabled: true, notifyMonthlyReport: false },
    ]);
    expect(chosen.map((c) => c.id)).toEqual(["yes"]);
  });
});

describe("renderNotificationEmail: report.monthly", () => {
  const options = { timeZone: "Europe/London", channelName: "Owners" };

  it("summarises the month and lists the clients with problems, linked when the app's address is known", () => {
    const payload = buildMonthlyReportPayload({
      workspaceName: "Northwind IT",
      at: AT,
      month: "2026-10",
      reports: [
        { client: client("c1", "Acme"), report: report(3, 1, 1) },
        {
          client: client("c2", "<Bravo & Co>"),
          report: report(1, 0.5, 0.75, { completed: 15, failed: 4 }, 2),
        },
      ],
    });
    const email = renderNotificationEmail(payload, {
      ...options,
      appBaseUrl: "https://app.example.com/",
    });
    expect(email.subject).toBe(`${brand.name}: backup summary for October 2026`);
    expect(email.text).toContain(
      "In October 2026, Northwind IT's 2 clients (4 assets) were on schedule 87.5% of days and within SLA 93.7%. 45 backups completed and 4 failed; 2 incidents were opened.",
    );
    expect(email.text).toContain(
      "<Bravo & Co>\n  - On schedule 50% of days, within SLA 75%; 4 failed backups; 2 incidents. 1 asset.",
    );
    expect(email.text).toContain("  https://app.example.com/clients/c2/report?month=2026-10");
    expect(email.text).toContain(
      "1 other client was on schedule every day, with no failed backups.",
    );
    expect(email.text).not.toContain("Acme\n");
    expect(email.html).toContain(
      '<a href="https://app.example.com/clients/c2/report?month=2026-10" style="color:#4b3fbf">&lt;Bravo &amp; Co&gt;</a>',
    );
    expect(email.html).not.toContain("<Bravo");
  });

  it("has no links without the app's address, and says so when every client was fine", () => {
    const payload = buildMonthlyReportPayload({
      workspaceName: "Northwind IT",
      at: AT,
      month: "2026-10",
      reports: [{ client: client("c1", "Acme"), report: report(3, 1, 1) }],
    });
    const email = renderNotificationEmail(payload, options);
    expect(email.text).toContain("Every client was on schedule every day, with no failed backups.");
    expect(email.text).not.toContain("http");
    expect(email.html).not.toContain("<a ");
    expect(email.html).not.toContain("Least reliable");
  });

  it("lists at most a set number of clients by name", () => {
    const reports = Array.from({ length: MAX_EMAIL_REPORT_CLIENTS + 4 }, (_, i) => ({
      client: client(`c${i}`, `Client ${i}`),
      report: report(1, 0.9, 1),
    }));
    const email = renderNotificationEmail(
      buildMonthlyReportPayload({ workspaceName: "W", at: AT, month: "2026-10", reports }),
      options,
    );
    expect(email.text.match(/On schedule 90%/g)).toHaveLength(MAX_EMAIL_REPORT_CLIENTS);
    expect(email.text).toContain("4 more clients also had problems.");
  });

  it("says when nothing was watched", () => {
    const email = renderNotificationEmail(
      buildMonthlyReportPayload({ workspaceName: "W", at: AT, month: "2026-10", reports: [] }),
      options,
    );
    expect(email.text).toContain("No client assets were being watched in W in October 2026.");
  });
});
