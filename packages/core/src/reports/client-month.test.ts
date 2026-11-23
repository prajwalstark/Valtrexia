import { describe, expect, it } from "vitest";
import { MUTED_INDEFINITELY } from "../asset-settings";
import {
  buildClientMonthReport,
  type ClientMonthInput,
  type ReportAsset,
  type ReportResult,
} from "./client-month";

const HOUR = 3_600_000;
const at = (iso: string) => new Date(iso);

function asset(overrides: Partial<ReportAsset> = {}): ReportAsset {
  return {
    id: "a1",
    name: "FS01",
    type: "server",
    deviceName: null,
    expectedFrequencyHours: 24,
    slaHours: 72,
    firstSeenAt: at("2026-01-01T00:00:00Z"),
    isPaused: false,
    isArchived: false,
    mutedUntil: null,
    ...overrides,
  };
}

/** A success at 02:00 UTC on each given day of October 2026, ending ten minutes later. */
function dailyOctober(assetId: string, days: number[], status: ReportResult["status"] = "success") {
  return days.map((day) => {
    const startedAt = at(`2026-10-${String(day).padStart(2, "0")}T02:00:00Z`);
    return { assetId, startedAt, endedAt: new Date(startedAt.getTime() + HOUR / 6), status };
  });
}

const ALL_OCTOBER = Array.from({ length: 31 }, (_, index) => index + 1);

function input(overrides: Partial<ClientMonthInput> = {}): ClientMonthInput {
  return {
    month: "2026-10",
    timeZone: "UTC",
    graceHours: 2,
    now: at("2026-11-23T12:00:00Z"),
    assets: [asset()],
    results: dailyOctober("a1", ALL_OCTOBER),
    lastCompletedBefore: new Map([["a1", at("2026-09-30T02:10:00Z")]]),
    incidents: [],
    ...overrides,
  };
}

describe("buildClientMonthReport: days", () => {
  it("scores an asset backed up every day as fully on schedule and within SLA", () => {
    const report = buildClientMonthReport(input());
    expect(report.partial).toBe(false);
    expect(report.days).toHaveLength(31);
    const [only] = report.assets;
    expect(only!.days).toHaveLength(31);
    expect(only!.onSchedule).toBe(1);
    expect(only!.withinSla).toBe(1);
    expect(only!.backups).toEqual({ completed: 31, failed: 0 });
    expect(only!.days.every((day) => day.worst === "success")).toBe(true);
  });

  it("judges each day at its end: a five-day gap is off schedule, and past the SLA after three days", () => {
    // Nothing from the 10th to the 14th. The last backup, on the 9th, ended at 02:10.
    const days = ALL_OCTOBER.filter((day) => day < 10 || day > 14);
    const report = buildClientMonthReport(input({ results: dailyOctober("a1", days) }));
    const cells = new Map(report.assets[0]!.days.map((day) => [day.date, day]));

    // End of the 9th: 21h50m since. End of the 10th: 45h50m, past 24 + 2.
    expect(cells.get("2026-10-09")!.onSchedule).toBe(true);
    expect(cells.get("2026-10-10")).toEqual({
      date: "2026-10-10",
      worst: null,
      onSchedule: false,
      withinSla: true,
    });
    // End of the 11th: 69h50m, still inside 72. End of the 12th: 93h50m.
    expect(cells.get("2026-10-11")!.withinSla).toBe(true);
    expect(cells.get("2026-10-12")!.withinSla).toBe(false);
    expect(cells.get("2026-10-14")!.withinSla).toBe(false);
    // The 15th's backup puts it right again by the end of that day.
    expect(cells.get("2026-10-15")).toMatchObject({ onSchedule: true, withinSla: true });

    expect(report.assets[0]!.onSchedule).toBeCloseTo(26 / 31);
    expect(report.assets[0]!.withinSla).toBeCloseTo(28 / 31);
  });

  it("scores a weekly asset by its own schedule, not by days without a backup", () => {
    // Sundays in October 2026: the 4th, 11th, 18th and 25th.
    const weekly = asset({ expectedFrequencyHours: 168, slaHours: 192 });
    const report = buildClientMonthReport(
      input({
        assets: [weekly],
        results: dailyOctober("a1", [4, 11, 18, 25]),
        lastCompletedBefore: new Map([["a1", at("2026-09-27T02:10:00Z")]]),
      }),
    );
    expect(report.assets[0]!.onSchedule).toBe(1);
    expect(report.assets[0]!.withinSla).toBe(1);
    expect(report.assets[0]!.days.filter((day) => day.worst === null)).toHaveLength(27);
  });

  it("counts a warning as a completed backup and shows a day's worst result", () => {
    const results = [
      ...dailyOctober(
        "a1",
        ALL_OCTOBER.filter((day) => day !== 5),
      ),
      ...dailyOctober("a1", [5], "warning"),
      {
        assetId: "a1",
        startedAt: at("2026-10-06T14:00:00Z"),
        endedAt: at("2026-10-06T14:05:00Z"),
        status: "failed" as const,
      },
    ];
    const report = buildClientMonthReport(input({ results }));
    const cells = new Map(report.assets[0]!.days.map((day) => [day.date, day]));
    expect(cells.get("2026-10-05")!.worst).toBe("warning");
    expect(cells.get("2026-10-06")!.worst).toBe("failed");
    expect(report.assets[0]!.onSchedule).toBe(1);
    expect(report.assets[0]!.backups).toEqual({ completed: 31, failed: 1 });
  });

  it("carries the last backup from before the month into its first days", () => {
    const report = buildClientMonthReport(input({ results: dailyOctober("a1", [3]) }));
    const cells = report.assets[0]!.days;
    // From 02:10 on 30 September: 21h50m at the end of the month's eve, 45h50m at the end of the 1st.
    expect(cells[0]).toMatchObject({ date: "2026-10-01", onSchedule: false, withinSla: true });
    expect(cells[2]).toMatchObject({ date: "2026-10-03", onSchedule: true, withinSla: true });
  });

  it("uses a backup that started before the month but ended in it, without counting it in the month", () => {
    const report = buildClientMonthReport(
      input({
        results: [
          {
            assetId: "a1",
            // A 33-hour backup: from its start, the 1st would be 52 hours on.
            startedAt: at("2026-09-29T20:00:00Z"),
            endedAt: at("2026-10-01T05:00:00Z"),
            status: "success",
          },
        ],
        lastCompletedBefore: new Map(),
      }),
    );
    expect(report.assets[0]!.days[0]).toMatchObject({ worst: null, onSchedule: true });
    expect(report.assets[0]!.backups.completed).toBe(0);
  });

  it("judges an earlier backup that finished inside the month from when it finished", () => {
    // Started before the loaded results, finished on the 5th: the 1st to 4th are not covered by it.
    const report = buildClientMonthReport(
      input({ results: [], lastCompletedBefore: new Map([["a1", at("2026-10-05T03:00:00Z")]]) }),
    );
    const cells = report.assets[0]!.days;
    expect(cells[3]).toMatchObject({ date: "2026-10-04", onSchedule: false, withinSla: false });
    expect(cells[4]).toMatchObject({ date: "2026-10-05", onSchedule: true, withinSla: true });
  });

  it("judges an asset never backed up from when it was first seen, and skips the days before", () => {
    const fresh = asset({ firstSeenAt: at("2026-10-20T09:00:00Z") });
    const report = buildClientMonthReport(
      input({ assets: [fresh], results: [], lastCompletedBefore: new Map() }),
    );
    const cells = report.assets[0]!.days;
    expect(cells[0]!.date).toBe("2026-10-20");
    expect(cells).toHaveLength(12);
    // End of the 20th: 15h. End of the 21st: 39h, past 26. End of the 23rd: 87h, past 72.
    expect(cells[0]).toMatchObject({ onSchedule: true, withinSla: true });
    expect(cells[1]).toMatchObject({ onSchedule: false, withinSla: true });
    expect(cells[3]).toMatchObject({ onSchedule: false, withinSla: false });
  });

  it("stops at today for the month in progress, judging today as of now", () => {
    const now = at("2026-11-05T01:00:00Z");
    const report = buildClientMonthReport(
      input({
        month: "2026-11",
        now,
        results: [1, 2, 3, 4].map((day) => ({
          assetId: "a1",
          startedAt: at(`2026-11-0${day}T02:00:00Z`),
          endedAt: at(`2026-11-0${day}T02:10:00Z`),
          status: "success" as const,
        })),
        lastCompletedBefore: new Map([["a1", at("2026-10-31T02:10:00Z")]]),
      }),
    );
    expect(report.partial).toBe(true);
    expect(report.days).toEqual([
      "2026-11-01",
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
      "2026-11-05",
    ]);
    const cells = report.assets[0]!.days;
    // The 4th ended 21h50m after the last backup; now is 22h50m after it.
    expect(cells[3]).toMatchObject({ onSchedule: true });
    expect(cells[4]).toMatchObject({ date: "2026-11-05", worst: null, onSchedule: true });
  });

  it("reports a month that has not begun as empty", () => {
    const report = buildClientMonthReport(input({ month: "2026-12" }));
    expect(report.days).toEqual([]);
    expect(report.assets[0]!.days).toEqual([]);
    expect(report.assets[0]!.onSchedule).toBe(1);
  });
});

describe("buildClientMonthReport: time zones", () => {
  it("places days and the month's edges in the workspace's time zone, across a clock change", () => {
    // London is an hour ahead until 25 October 2026, then on UTC.
    const results: ReportResult[] = [
      // 00:30 on 1 October in London: in the month.
      { assetId: "a1", startedAt: at("2026-09-30T23:30:00Z"), endedAt: null, status: "failed" },
      // 00:30 on 1 November in London: not.
      { assetId: "a1", startedAt: at("2026-11-01T00:30:00Z"), endedAt: null, status: "failed" },
      // 23:30 UTC on the 24th is the 25th in London; 23:30 on the 25th is still the 25th.
      { assetId: "a1", startedAt: at("2026-10-24T23:30:00Z"), endedAt: null, status: "warning" },
      { assetId: "a1", startedAt: at("2026-10-25T23:30:00Z"), endedAt: null, status: "failed" },
    ];
    const report = buildClientMonthReport(
      input({ timeZone: "Europe/London", results, lastCompletedBefore: new Map() }),
    );
    const cells = new Map(report.assets[0]!.days.map((day) => [day.date, day]));
    expect(report.days).toHaveLength(31);
    expect(cells.get("2026-10-01")!.worst).toBe("failed");
    expect(cells.get("2026-10-24")!.worst).toBeNull();
    expect(cells.get("2026-10-25")!.worst).toBe("failed");
    expect(report.assets[0]!.backups).toEqual({ completed: 1, failed: 2 });
  });

  it("judges the 25-hour day of a clock change at its real end", () => {
    // A backup at 00:10 London time (23:10 UTC) on the 25th. That day lasts 25 hours,
    // so it ends 24h50m later; the next day ends 48h50m later, past 26 even before grace.
    const report = buildClientMonthReport(
      input({
        timeZone: "Europe/London",
        results: [
          {
            assetId: "a1",
            startedAt: at("2026-10-24T23:00:00Z"),
            endedAt: at("2026-10-24T23:10:00Z"),
            status: "success",
          },
        ],
        lastCompletedBefore: new Map(),
        assets: [asset({ firstSeenAt: at("2026-10-24T22:00:00Z") })],
        graceHours: 0,
      }),
    );
    const cells = new Map(report.assets[0]!.days.map((day) => [day.date, day]));
    expect(cells.get("2026-10-25")!.onSchedule).toBe(false);
    expect(cells.get("2026-10-25")!.withinSla).toBe(true);
  });
});

describe("buildClientMonthReport: assets and incidents", () => {
  it("lists paused, archived and indefinitely muted assets as excluded, and counts the rest", () => {
    const report = buildClientMonthReport(
      input({
        assets: [
          asset(),
          asset({ id: "a2", name: "Old NAS", isArchived: true }),
          asset({ id: "a3", name: "Lab", isPaused: true }),
          asset({ id: "a4", name: "Kiosk", mutedUntil: MUTED_INDEFINITELY }),
          asset({ id: "a5", name: "Laptop", mutedUntil: at("2026-10-12T00:00:00Z") }),
          asset({ id: "a6", name: "New", firstSeenAt: at("2026-11-02T00:00:00Z") }),
        ],
      }),
    );
    expect(report.excluded).toEqual([
      { name: "Kiosk", reason: "muted" },
      { name: "Lab", reason: "paused" },
      { name: "Old NAS", reason: "archived" },
    ]);
    expect(report.assets.map((row) => row.name)).toEqual(["Laptop", "FS01"]);
    expect(report.summary.assets).toBe(2);
  });

  it("sorts the worst asset first and averages the shares", () => {
    const report = buildClientMonthReport(
      input({
        assets: [asset(), asset({ id: "a2", name: "DB01" })],
        lastCompletedBefore: new Map([
          ["a1", at("2026-09-30T02:10:00Z")],
          ["a2", at("2026-09-30T02:10:00Z")],
        ]),
      }),
    );
    expect(report.assets.map((row) => row.name)).toEqual(["DB01", "FS01"]);
    expect(report.assets[0]!.onSchedule).toBeLessThan(0.1);
    expect(report.summary.onSchedule).toBeCloseTo((report.assets[0]!.onSchedule + 1) / 2);
    expect(report.summary.backups).toEqual({ completed: 31, failed: 0 });
  });

  it("has no averages with nothing counted", () => {
    const report = buildClientMonthReport(input({ assets: [] }));
    expect(report.summary).toEqual({
      assets: 0,
      onSchedule: null,
      withinSla: null,
      backups: { completed: 0, failed: 0 },
    });
    expect(report.incidents.medianHoursToClose).toBeNull();
  });

  it("counts incidents opened and closed in the month, with the median time to close", () => {
    const report = buildClientMonthReport(
      input({
        assets: [asset(), asset({ id: "a2", name: "Lab", isPaused: true })],
        incidents: [
          // Opened in September, closed in October after 48 hours.
          {
            assetId: "a1",
            type: "missed",
            openedAt: at("2026-09-30T12:00:00Z"),
            closedAt: at("2026-10-02T12:00:00Z"),
          },
          {
            assetId: "a1",
            type: "failed",
            openedAt: at("2026-10-05T00:00:00Z"),
            closedAt: at("2026-10-05T02:00:00Z"),
          },
          {
            assetId: "a1",
            type: "failed",
            openedAt: at("2026-10-10T00:00:00Z"),
            closedAt: at("2026-10-10T06:00:00Z"),
          },
          // Still open.
          { assetId: "a1", type: "stale", openedAt: at("2026-10-30T00:00:00Z"), closedAt: null },
          // Opened in October, closed in November.
          {
            assetId: "a1",
            type: "failed",
            openedAt: at("2026-10-31T20:00:00Z"),
            closedAt: at("2026-11-01T02:00:00Z"),
          },
          // An excluded asset's.
          {
            assetId: "a2",
            type: "failed",
            openedAt: at("2026-10-07T00:00:00Z"),
            closedAt: at("2026-10-07T01:00:00Z"),
          },
        ],
      }),
    );
    expect(report.incidents).toEqual({
      opened: { failed: 3, missed: 0, stale: 1 },
      closed: { failed: 2, missed: 1, stale: 0 },
      medianHoursToClose: 6,
    });
  });
});
