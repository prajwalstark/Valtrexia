import { describe, expect, it } from "vitest";
import { cellStatus, reportMonth } from "./report-core";

describe("reportMonth", () => {
  const now = new Date("2026-11-23T12:00:00Z");

  it("defaults to the last full month", () => {
    expect(reportMonth(undefined, now, "UTC")).toBe("2026-10");
    // Midnight on 1 December has already come in Tokyo.
    expect(reportMonth(undefined, new Date("2026-11-30T20:00:00Z"), "Asia/Tokyo")).toBe("2026-11");
  });

  it("takes a month from the current one back twelve, and nothing else", () => {
    expect(reportMonth("2026-11", now, "UTC")).toBe("2026-11");
    expect(reportMonth("2025-11", now, "UTC")).toBe("2025-11");
    expect(reportMonth("2025-10", now, "UTC")).toBe("2026-10");
    expect(reportMonth("2026-12", now, "UTC")).toBe("2026-10");
    expect(reportMonth("2026-1", now, "UTC")).toBe("2026-10");
    expect(reportMonth("<script>", now, "UTC")).toBe("2026-10");
  });
});

describe("cellStatus", () => {
  const day = { date: "2026-10-01", withinSla: true };

  it("shows the worst result, a missed day when behind schedule, or nothing", () => {
    expect(cellStatus({ ...day, worst: "warning", onSchedule: true })).toBe("warning");
    expect(cellStatus({ ...day, worst: "failed", onSchedule: false })).toBe("failed");
    expect(cellStatus({ ...day, worst: null, onSchedule: false })).toBe("overdue");
    expect(cellStatus({ ...day, worst: null, onSchedule: true })).toBeNull();
  });
});
