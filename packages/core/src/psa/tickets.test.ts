import { describe, expect, it } from "vitest";
import { brand } from "../brand";
import type { IncidentPayloadEntry } from "../notifications/plan";
import { isClosedStatus, refInSubject, ticketNews, ticketRef, ticketSubject } from "./tickets";

const entry = (overrides: Partial<IncidentPayloadEntry> = {}): IncidentPayloadEntry => ({
  incidentId: "i1",
  type: "failed",
  client: { id: "c1", name: "Acme Dental" },
  asset: { id: "a1", name: "SRV01" },
  openedAt: "2026-11-12T03:00:00.000Z",
  closedAt: null,
  lastBackupAt: "2026-11-11T02:30:00.000Z",
  reason: null,
  ...overrides,
});
const base = { allClear: false, resolvedStatus: "Resolved", timeZone: "Europe/London" };

describe("ticket wording", () => {
  it("writes a subject with the problem, asset, client and a reference to find it by", () => {
    const ref = ticketRef("3f9a2c1b-7d4e-4a8b-9c0d-112233445566");
    expect(ref).toBe("3f9a2c1b7d");
    expect(ticketSubject(entry(), ref)).toBe("Backup failed: SRV01 (Acme Dental) [ref 3f9a2c1b7d]");
    const long = ticketSubject(entry({ asset: { id: "a", name: "x".repeat(400) } }), ref);
    expect(long).toHaveLength(250);
    expect(long.endsWith(refInSubject(ref))).toBe(true);
    expect(ticketSubject(entry({ asset: { id: "a", name: "A\nB" } }), ref)).not.toContain("\n");
  });

  it("describes what opened, with times in the workspace's zone", () => {
    const news = ticketNews({
      ...base,
      opened: [entry(), entry({ type: "stale", lastBackupAt: null })],
      closed: [],
    });
    expect(news.subject).toBe("Backup failed");
    expect(news.body).toBe(
      "Backup failed on SRV01, since 12 Nov, 03:00 GMT. Last good backup 11 Nov, 02:30 GMT.\n\n" +
        "Past its backup SLA on SRV01, since 12 Nov, 03:00 GMT. No good backup on record.",
    );
  });

  it("says what resolved, what is no longer tracked, and when the ticket is being closed, with a link", () => {
    const news = ticketNews({
      ...base,
      allClear: true,
      resolvedStatus: "Done",
      appBaseUrl: "https://app.example.com/",
      opened: [],
      closed: [
        entry({ closedAt: "2026-11-12T09:15:00.000Z", reason: "resolved" }),
        entry({ type: "missed", closedAt: "2026-11-12T09:15:00.000Z", reason: "suppressed" }),
      ],
    });
    expect(news.subject).toBe("Backup problems resolved");
    expect(news.body.split("\n\n")).toEqual([
      "Resolved: backup failed on SRV01, at 12 Nov, 09:15 GMT.",
      `No longer tracked: backup missed on SRV01. The asset was muted, paused or archived in ${brand.name}.`,
      "No backup problem on SRV01 is open now. Setting this ticket to Done.",
      `Acme Dental in ${brand.name}: https://app.example.com/clients/c1`,
    ]);
  });

  it("knows a closed status when it sees one", () => {
    expect(isClosedStatus("Resolved", "Done")).toBe(true);
    expect(isClosedStatus("invoiced", "Resolved")).toBe(true);
    expect(isClosedStatus("Done", "Done")).toBe(true);
    expect(isClosedStatus("In Progress", "Resolved")).toBe(false);
  });
});
