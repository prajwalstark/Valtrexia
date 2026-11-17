import { describe, expect, it } from "vitest";
import { brand } from "../brand";
import { escapeHtml, renderNotificationEmail } from "./email";
import {
  buildIncidentsPayload,
  buildIntegrationHealthPayload,
  buildTestPayload,
  type IncidentChange,
} from "./plan";

const NOW = new Date("2026-11-12T15:00:00Z");
const options = { timeZone: "UTC", channelName: "On-call" };

let next = 0;
const change = (overrides: Partial<IncidentChange> = {}): IncidentChange => {
  next += 1;
  const event = overrides.event ?? "opened";
  return {
    incidentId: `i${next}`,
    type: "failed",
    event,
    reason: event === "closed" ? "resolved" : null,
    client: { id: "c1", name: "Acme Dental" },
    asset: { id: `a${next}`, name: `SRV${next}` },
    openedAt: new Date("2026-11-12T03:00:00Z"),
    closedAt: event === "closed" ? NOW : null,
    lastBackupAt: new Date("2026-11-11T02:30:00Z"),
    ...overrides,
  };
};
const incidents = (changes: IncidentChange[], workspaceName = "Northwind IT") =>
  buildIncidentsPayload({ workspaceName, at: NOW, changes });

describe("renderNotificationEmail: incidents", () => {
  it("names the problems, the client and the last good backup", () => {
    const email = renderNotificationEmail(
      incidents([
        change({ asset: { id: "a", name: "SQL01" }, type: "failed" }),
        change({ asset: { id: "b", name: "FS01" }, type: "missed", lastBackupAt: null }),
      ]),
      options,
    );
    expect(email.subject).toBe(`${brand.name}: 2 new backup problems at Acme Dental`);
    expect(email.text).toBe(
      [
        "2 new backup problems in Northwind IT at Acme Dental.",
        "",
        "NEEDS ATTENTION",
        "",
        "Acme Dental",
        "  - SQL01: Backup failed. Last good backup 11 Nov, 02:30 UTC.",
        "  - FS01: Backup missed. No good backup on record.",
        "",
        "--",
        `Times are in UTC. You receive this because you are listed on the "On-call" notification channel in ${brand.name}.`,
      ].join("\n"),
    );
  });

  it("groups by client, and leaves the client out of the subject when there are several", () => {
    const email = renderNotificationEmail(
      incidents([
        change({ client: { id: "c1", name: "Acme Dental" } }),
        change({ client: { id: "c2", name: "Birch Law" } }),
        change({ client: { id: "c1", name: "Acme Dental" }, event: "closed", type: "stale" }),
      ]),
      options,
    );
    expect(email.subject).toBe(`${brand.name}: 2 new backup problems, 1 resolved`);
    expect(email.text).toContain("NEEDS ATTENTION\n\nAcme Dental\n  - ");
    expect(email.text).toContain("\n\nBirch Law\n  - ");
    expect(email.text).toContain("RESOLVED\n\nAcme Dental\n  - ");
    expect(email.text).toContain("Back within its SLA at 12 Nov, 15:00 UTC.");
  });

  it("says when only resolutions are being reported", () => {
    const email = renderNotificationEmail(incidents([change({ event: "closed" })]), options);
    expect(email.subject).toBe(`${brand.name}: 1 backup problem resolved at Acme Dental`);
    expect(email.text.startsWith("1 backup problem resolved in Northwind IT")).toBe(true);
  });

  it("writes every time in the workspace's time zone", () => {
    const email = renderNotificationEmail(incidents([change()]), {
      timeZone: "America/New_York",
      channelName: "On-call",
    });
    // 02:30 UTC on the 11th is 21:30 on the 10th in New York.
    expect(email.text).toContain("Last good backup 10 Nov, 21:30 GMT-5.");
    expect(email.text).toContain("Times are in America/New York.");
  });
});

describe("renderNotificationEmail: integrations and tests", () => {
  const base = {
    workspaceName: "Northwind IT",
    at: NOW,
    integration: { id: "int1", name: "Datto main", vendor: "datto_bcdr" },
    failingSince: new Date("2026-11-12T14:00:00Z"),
    error: "The vendor rejected these credentials.",
  };

  it("says an integration is failing, why, and whether waiting will help", () => {
    const rejected = renderNotificationEmail(
      buildIntegrationHealthPayload({ ...base, state: "unhealthy", needsAction: true }),
      options,
    );
    expect(rejected.subject).toBe(`${brand.name}: Datto main is failing to sync`);
    expect(rejected.text).toContain("Datto main has been failing to sync since 12 Nov, 14:00 UTC.");
    expect(rejected.text).toContain(
      "The last attempt said: The vendor rejected these credentials.",
    );
    expect(rejected.text).toContain("until its keys are replaced");

    const outage = renderNotificationEmail(
      buildIntegrationHealthPayload({ ...base, state: "unhealthy", needsAction: false }),
      options,
    );
    expect(outage.text).toContain("Syncs are retried every few minutes.");
  });

  it("says when it recovers", () => {
    const email = renderNotificationEmail(
      buildIntegrationHealthPayload({ ...base, state: "recovered", needsAction: false }),
      options,
    );
    expect(email.subject).toBe(`${brand.name}: Datto main is syncing again`);
    expect(email.text).toContain("after failing since 12 Nov, 14:00 UTC");
  });

  it("renders a test message", () => {
    const email = renderNotificationEmail(
      buildTestPayload({ workspaceName: "Northwind IT", at: NOW }),
      options,
    );
    expect(email.subject).toBe(`${brand.name}: test notification`);
    expect(email.text).toContain(
      "this channel works. It was sent from Northwind IT at 12 Nov, 15:00 UTC.",
    );
  });
});

describe("renderNotificationEmail: what cannot get through", () => {
  const hostile = '<script>alert("x")</script> & <img src=x onerror=y>';

  it("escapes names from vendors and people in the HTML body", () => {
    const email = renderNotificationEmail(
      incidents(
        [change({ client: { id: "c", name: hostile }, asset: { id: "a", name: hostile } })],
        hostile,
      ),
      { timeZone: "UTC", channelName: hostile },
    );
    expect(email.html).not.toContain("<script>");
    expect(email.html).not.toContain("<img");
    expect(email.html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &lt;img");
    // The text body is plain text: shown as written, never interpreted.
    expect(email.text).toContain(hostile);
  });

  it("keeps the subject to one line, whatever a name contains", () => {
    const email = renderNotificationEmail(
      incidents([change({ client: { id: "c", name: "Acme\r\nBcc: victim@example.com" } })]),
      options,
    );
    expect(email.subject).not.toMatch(/[\r\n]/);
    expect(email.subject).toBe(
      `${brand.name}: 1 new backup problem at Acme Bcc: victim@example.com`,
    );
  });

  it("escapes the five characters that matter", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });
});
