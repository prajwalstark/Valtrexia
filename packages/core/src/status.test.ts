import { describe, expect, it } from "vitest";
import {
  BACKUP_STATUSES,
  isBackupStatus,
  isCompletedBackup,
  lastCompletedBackupAt,
  statusSeverity,
  worstStatus,
} from "./status";

describe("backup status", () => {
  it("recognizes exactly the six normalized values", () => {
    expect([...BACKUP_STATUSES]).toEqual([
      "success",
      "warning",
      "failed",
      "missed",
      "running",
      "unknown",
    ]);
    for (const status of BACKUP_STATUSES) expect(isBackupStatus(status)).toBe(true);
    for (const other of ["SUCCESS", "ok", "", null, undefined, 1, {}]) {
      expect(isBackupStatus(other)).toBe(false);
    }
  });

  it("ranks severity failed > missed > warning > unknown > running > success", () => {
    const ranked = [...BACKUP_STATUSES].sort((a, b) => statusSeverity(b) - statusSeverity(a));
    expect(ranked).toEqual(["failed", "missed", "warning", "unknown", "running", "success"]);
  });

  it("picks the worst of several statuses", () => {
    expect(worstStatus(["success", "warning", "success"])).toBe("warning");
    expect(worstStatus(["running", "success"])).toBe("running");
    expect(worstStatus(["unknown", "success", "running"])).toBe("unknown");
    expect(worstStatus(["missed", "failed", "warning"])).toBe("failed");
    expect(worstStatus([])).toBeNull();
  });

  it("counts success and warning as a completed backup, and nothing else", () => {
    expect(BACKUP_STATUSES.filter(isCompletedBackup)).toEqual(["success", "warning"]);
  });
});

describe("lastCompletedBackupAt", () => {
  const at = (iso: string) => new Date(iso);

  it("returns null when there has never been a completed backup", () => {
    expect(lastCompletedBackupAt([])).toBeNull();
    expect(
      lastCompletedBackupAt([
        { status: "failed", startedAt: at("2026-11-10T01:00:00Z"), endedAt: null },
        { status: "running", startedAt: at("2026-11-11T01:00:00Z"), endedAt: null },
        { status: "unknown", startedAt: at("2026-11-12T01:00:00Z"), endedAt: null },
      ]),
    ).toBeNull();
  });

  it("ignores a later failure and returns the last success or warning", () => {
    expect(
      lastCompletedBackupAt([
        {
          status: "success",
          startedAt: at("2026-11-10T01:00:00Z"),
          endedAt: at("2026-11-10T01:30:00Z"),
        },
        {
          status: "warning",
          startedAt: at("2026-11-11T01:00:00Z"),
          endedAt: at("2026-11-11T01:45:00Z"),
        },
        {
          status: "failed",
          startedAt: at("2026-11-12T01:00:00Z"),
          endedAt: at("2026-11-12T01:05:00Z"),
        },
      ]),
    ).toEqual(at("2026-11-11T01:45:00Z"));
  });

  it("falls back to the start time when a result has no end time, in any input order", () => {
    expect(
      lastCompletedBackupAt([
        { status: "success", startedAt: at("2026-11-12T03:00:00Z"), endedAt: null },
        {
          status: "success",
          startedAt: at("2026-11-10T01:00:00Z"),
          endedAt: at("2026-11-10T01:30:00Z"),
        },
      ]),
    ).toEqual(at("2026-11-12T03:00:00Z"));
  });
});
