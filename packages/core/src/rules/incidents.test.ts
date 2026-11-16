import { describe, expect, it } from "vitest";
import { BACKUP_STATUSES, type BackupStatus } from "../status";
import { planIncidents, type RaisedIncidentType } from "./incidents";
import type { MissedBackupVerdict } from "./missed-backup";
import type { SlaVerdict } from "./sla";

const at = new Date("2026-11-12T12:00:00Z");
const OK: MissedBackupVerdict = { state: "ok", deadline: at };
const MISSED: MissedBackupVerdict = { state: "missed", deadline: at, hoursOverdue: 5 };
const SUPPRESSED: MissedBackupVerdict = { state: "suppressed", reason: "paused" };
const INDETERMINATE: MissedBackupVerdict = { state: "indeterminate", reason: "sync_failing" };
const UNCONFIRMED: MissedBackupVerdict = {
  state: "unconfirmed",
  reason: "sync_failing",
  deadline: at,
  lastSyncAt: at,
};

const SLA_OK: SlaVerdict = { state: "ok", deadline: at, effectiveSlaHours: 72 };
const SLA_BREACHED: SlaVerdict = {
  state: "breached",
  deadline: at,
  hoursOverdue: 9,
  effectiveSlaHours: 72,
};
const SLA_SUPPRESSED: SlaVerdict = { state: "suppressed", reason: "paused" };
const SLA_INDETERMINATE: SlaVerdict = { state: "indeterminate", reason: "sync_failing" };

/** The SLA verdict that goes with a missed-backup verdict when the test does not give one. */
const slaFor = (verdict: MissedBackupVerdict): SlaVerdict =>
  verdict.state === "suppressed"
    ? SLA_SUPPRESSED
    : verdict.state === "indeterminate" || verdict.state === "unconfirmed"
      ? SLA_INDETERMINATE
      : SLA_OK;

const plan = (
  lastResultStatus: BackupStatus | null,
  verdict: MissedBackupVerdict,
  open: RaisedIncidentType[] = [],
  sla: SlaVerdict = slaFor(verdict),
) => planIncidents({ lastResultStatus, verdict, sla, open: new Set(open) });

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

  it("is neither opened nor closed when the backup is unconfirmed", () => {
    // The window has closed but we could not look: that is not a missed backup.
    expect(plan("success", UNCONFIRMED)).toEqual({ open: [], close: [] });
    expect(plan("success", UNCONFIRMED, ["missed"])).toEqual({ open: [], close: [] });
    expect(plan("failed", UNCONFIRMED, ["failed", "missed"])).toEqual({ open: [], close: [] });
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

describe("planIncidents: stale", () => {
  it("opens when the SLA is breached", () => {
    expect(plan("success", MISSED, ["missed"], SLA_BREACHED)).toEqual({
      open: ["stale"],
      close: [],
    });
  });

  it("does not open a second one while one is open", () => {
    expect(plan("success", MISSED, ["missed", "stale"], SLA_BREACHED)).toEqual({
      open: [],
      close: [],
    });
  });

  it("closes when a backup is back inside the SLA", () => {
    expect(plan("success", OK, ["stale"], SLA_OK)).toEqual({ open: [], close: ["stale"] });
  });

  it("is left exactly as it is when the vendor data cannot be trusted", () => {
    expect(plan("success", INDETERMINATE, ["stale"])).toEqual({ open: [], close: [] });
    expect(plan("success", UNCONFIRMED, ["stale"])).toEqual({ open: [], close: [] });
    expect(plan("success", INDETERMINATE)).toEqual({ open: [], close: [] });
  });

  it("is independent of the latest result: a failed attempt neither opens nor closes it", () => {
    expect(plan("failed", MISSED, ["failed", "missed"], SLA_OK)).toEqual({ open: [], close: [] });
    expect(plan("running", MISSED, ["missed", "stale"], SLA_BREACHED)).toEqual({
      open: [],
      close: [],
    });
  });

  it("an asset failing for days has all three, opened as each line is crossed", () => {
    // First night: the attempt failed.
    expect(plan("failed", OK, [], SLA_OK)).toEqual({ open: ["failed"], close: [] });
    // Second day: no backup completed in its window either.
    expect(plan("failed", MISSED, ["failed"], SLA_OK)).toEqual({ open: ["missed"], close: [] });
    // Fourth day: longer than the SLA without any good backup.
    expect(plan("failed", MISSED, ["failed", "missed"], SLA_BREACHED)).toEqual({
      open: ["stale"],
      close: [],
    });
    // A backup completes: all three close together.
    expect(plan("success", OK, ["failed", "missed", "stale"], SLA_OK)).toEqual({
      open: [],
      close: ["failed", "missed", "stale"],
    });
  });
});

describe("planIncidents: assets that are not being watched", () => {
  it("closes everything for an archived, paused or muted asset, whatever its last result", () => {
    for (const status of BACKUP_STATUSES) {
      expect(plan(status, SUPPRESSED, ["failed", "missed", "stale"])).toEqual({
        open: [],
        close: ["failed", "missed", "stale"],
      });
    }
  });

  it("opens nothing for one", () => {
    expect(plan("failed", SUPPRESSED)).toEqual({ open: [], close: [] });
  });
});

describe("planIncidents: invariants", () => {
  // Every pairing of the two rules' verdicts that can occur together. Both
  // rules agree on suppression and on whether the data can be trusted.
  const verdicts: [MissedBackupVerdict, SlaVerdict][] = [
    [OK, SLA_OK],
    [MISSED, SLA_OK],
    [MISSED, SLA_BREACHED],
    [SUPPRESSED, SLA_SUPPRESSED],
    [INDETERMINATE, SLA_INDETERMINATE],
    [UNCONFIRMED, SLA_INDETERMINATE],
  ];
  const types: RaisedIncidentType[] = ["failed", "missed", "stale"];
  const openSets: RaisedIncidentType[][] = Array.from({ length: 8 }, (_, bits) =>
    types.filter((_type, index) => bits & (1 << index)),
  );

  it("never opens what is open, never closes what is not, never does both to one type", () => {
    for (const status of [...BACKUP_STATUSES, null]) {
      for (const [verdict, sla] of verdicts) {
        for (const open of openSets) {
          const result = plan(status, verdict, open, sla);
          for (const type of result.open) expect(open).not.toContain(type);
          for (const type of result.close) expect(open).toContain(type);
          expect(result.open.filter((type) => result.close.includes(type))).toEqual([]);
        }
      }
    }
  });

  it("is settled: applying the plan and planning again changes nothing", () => {
    for (const status of [...BACKUP_STATUSES, null]) {
      for (const [verdict, sla] of verdicts) {
        for (const open of openSets) {
          const first = plan(status, verdict, open, sla);
          const after = [...open.filter((t) => !first.close.includes(t)), ...first.open];
          expect(plan(status, verdict, after, sla)).toEqual({ open: [], close: [] });
        }
      }
    }
  });
});
