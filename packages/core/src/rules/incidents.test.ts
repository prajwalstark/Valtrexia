import { describe, expect, it } from "vitest";
import { BACKUP_STATUSES, type BackupStatus } from "../status";
import { planIncidents, type RaisedIncidentType } from "./incidents";
import type { MissedBackupVerdict } from "./missed-backup";

const at = new Date("2026-11-12T12:00:00Z");
const OK: MissedBackupVerdict = { state: "ok", deadline: at };
const MISSED: MissedBackupVerdict = { state: "missed", deadline: at, hoursOverdue: 5 };
const SUPPRESSED: MissedBackupVerdict = { state: "suppressed", reason: "paused" };
const INDETERMINATE: MissedBackupVerdict = { state: "indeterminate", reason: "sync_failing" };

const plan = (
  lastResultStatus: BackupStatus | null,
  verdict: MissedBackupVerdict,
  open: RaisedIncidentType[] = [],
) => planIncidents({ lastResultStatus, verdict, open: new Set(open) });

describe("planIncidents: failed", () => {
  it("opens when the latest result failed", () => {
    expect(plan("failed", OK)).toEqual({ open: ["failed"], close: [] });
  });

  it("does not open a second one while one is open", () => {
    expect(plan("failed", OK, ["failed"])).toEqual({ open: [], close: [] });
  });

  it.each(["success", "warning"] as const)("closes once a backup completes (%s)", (status) => {
    expect(plan(status, OK, ["failed"])).toEqual({ open: [], close: ["failed"] });
  });

  it.each(["running", "unknown", null] as const)(
    "is left open while the outcome is not known (%s)",
    (status) => {
      expect(plan(status, OK, ["failed"])).toEqual({ open: [], close: [] });
    },
  );

  it("does nothing for a healthy asset with nothing open", () => {
    for (const status of ["success", "warning", "running", "unknown", null] as const) {
      expect(plan(status, OK)).toEqual({ open: [], close: [] });
    }
  });

  it("is not opened by a missed status: missed is not a vendor result", () => {
    expect(plan("missed", OK)).toEqual({ open: [], close: [] });
  });
});

describe("planIncidents: missed", () => {
  it("opens when the rule says a backup was missed", () => {
    expect(plan("success", MISSED)).toEqual({ open: ["missed"], close: [] });
    expect(plan(null, MISSED)).toEqual({ open: ["missed"], close: [] });
  });

  it("does not open a second one while one is open", () => {
    expect(plan("success", MISSED, ["missed"])).toEqual({ open: [], close: [] });
  });

  it("closes when a backup is back inside its window", () => {
    expect(plan("success", OK, ["missed"])).toEqual({ open: [], close: ["missed"] });
  });

  it("is left exactly as it is when the vendor data cannot be trusted", () => {
    expect(plan("success", INDETERMINATE, ["missed"])).toEqual({ open: [], close: [] });
    expect(plan("success", INDETERMINATE)).toEqual({ open: [], close: [] });
  });
});

describe("planIncidents: both at once", () => {
  it("opens both when the latest attempt failed and no backup completed in time", () => {
    expect(plan("failed", MISSED)).toEqual({ open: ["failed", "missed"], close: [] });
  });

  it("closes both when a backup completes", () => {
    expect(plan("success", OK, ["failed", "missed"])).toEqual({
      open: [],
      close: ["failed", "missed"],
    });
  });

  it("handles one opening while the other closes", () => {
    // Failed days ago and is now simply silent: the retry did not fail, there was none.
    expect(plan("failed", MISSED, ["failed"])).toEqual({ open: ["missed"], close: [] });
    // A backup completed (closing "failed") but was already too late (still "missed").
    expect(plan("success", MISSED, ["failed"])).toEqual({ open: ["missed"], close: ["failed"] });
  });

  it("keeps a failed incident open through a vendor outage, and does not touch missed", () => {
    expect(plan("failed", INDETERMINATE, ["failed", "missed"])).toEqual({ open: [], close: [] });
  });
});

describe("planIncidents: assets that are not being watched", () => {
  it("closes everything for an archived, paused or muted asset, whatever its last result", () => {
    for (const status of BACKUP_STATUSES) {
      expect(plan(status, SUPPRESSED, ["failed", "missed"])).toEqual({
        open: [],
        close: ["failed", "missed"],
      });
    }
  });

  it("opens nothing for one", () => {
    expect(plan("failed", SUPPRESSED)).toEqual({ open: [], close: [] });
  });
});

describe("planIncidents: invariants", () => {
  const verdicts = [OK, MISSED, SUPPRESSED, INDETERMINATE];
  const openSets: RaisedIncidentType[][] = [[], ["failed"], ["missed"], ["failed", "missed"]];

  it("never opens what is open, never closes what is not, never does both to one type", () => {
    for (const status of [...BACKUP_STATUSES, null]) {
      for (const verdict of verdicts) {
        for (const open of openSets) {
          const result = plan(status, verdict, open);
          for (const type of result.open) expect(open).not.toContain(type);
          for (const type of result.close) expect(open).toContain(type);
          expect(result.open.filter((type) => result.close.includes(type))).toEqual([]);
        }
      }
    }
  });

  it("is settled: applying the plan and planning again changes nothing", () => {
    for (const status of [...BACKUP_STATUSES, null]) {
      for (const verdict of verdicts) {
        for (const open of openSets) {
          const first = plan(status, verdict, open);
          const after = [...open.filter((t) => !first.close.includes(t)), ...first.open];
          expect(plan(status, verdict, after)).toEqual({ open: [], close: [] });
        }
      }
    }
  });
});
