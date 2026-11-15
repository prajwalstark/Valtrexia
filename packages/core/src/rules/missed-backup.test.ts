import { describe, expect, it } from "vitest";
import { BACKUP_STATUSES } from "../status";
import {
  deriveCurrentStatus,
  evaluateMissedBackup,
  statusInView,
  type MissedBackupInput,
  type MissedBackupVerdict,
} from "./missed-backup";

const NOW = new Date("2026-11-12T12:00:00.000Z");
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

/** A daily asset, last backed up 6 hours ago, on a healthy integration. */
function input(overrides: {
  asset?: Partial<MissedBackupInput["asset"]>;
  integration?: Partial<MissedBackupInput["integration"]>;
  graceHours?: number;
  syncIntervalMinutes?: number;
  now?: Date;
}): MissedBackupInput {
  return {
    now: overrides.now ?? NOW,
    asset: {
      expectedFrequencyHours: 24,
      firstSeenAt: hoursAgo(24 * 30),
      lastCompletedAt: hoursAgo(6),
      mutedUntil: null,
      isPaused: false,
      isArchived: false,
      ...overrides.asset,
    },
    graceHours: overrides.graceHours ?? 2,
    integration: { syncStatus: "ok", lastSyncAt: minutesAgo(5), ...overrides.integration },
    syncIntervalMinutes: overrides.syncIntervalMinutes ?? 15,
  };
}

describe("evaluateMissedBackup: the window", () => {
  it("is ok when the last completed backup is inside frequency + grace", () => {
    const verdict = evaluateMissedBackup(input({ asset: { lastCompletedAt: hoursAgo(6) } }));
    expect(verdict).toEqual({ state: "ok", deadline: new Date("2026-11-13T08:00:00.000Z") });
  });

  it("is ok when past the expected frequency but still inside the grace period", () => {
    const verdict = evaluateMissedBackup(input({ asset: { lastCompletedAt: hoursAgo(25) } }));
    expect(verdict.state).toBe("ok");
  });

  it("is ok exactly at the deadline and missed one millisecond after", () => {
    const atDeadline = input({ asset: { lastCompletedAt: hoursAgo(26) } });
    expect(evaluateMissedBackup(atDeadline).state).toBe("ok");

    const justAfter = input({
      asset: { lastCompletedAt: new Date(hoursAgo(26).getTime() - 1) },
    });
    expect(evaluateMissedBackup(justAfter).state).toBe("missed");
  });

  it("reports the deadline and how far past it we are", () => {
    const verdict = evaluateMissedBackup(input({ asset: { lastCompletedAt: hoursAgo(50) } }));
    expect(verdict).toEqual({
      state: "missed",
      deadline: hoursAgo(24),
      hoursOverdue: 24,
    });
  });

  it("uses the asset's own frequency", () => {
    const hourly = { expectedFrequencyHours: 1, lastCompletedAt: hoursAgo(4) };
    expect(evaluateMissedBackup(input({ asset: hourly })).state).toBe("missed");

    const weekly = { expectedFrequencyHours: 168, lastCompletedAt: hoursAgo(100) };
    expect(evaluateMissedBackup(input({ asset: weekly })).state).toBe("ok");
  });

  it("uses the tenant's grace period", () => {
    const asset = { lastCompletedAt: hoursAgo(30) };
    expect(evaluateMissedBackup(input({ asset, graceHours: 2 })).state).toBe("missed");
    expect(evaluateMissedBackup(input({ asset, graceHours: 8 })).state).toBe("ok");
    expect(evaluateMissedBackup(input({ asset, graceHours: 0 })).state).toBe("missed");
  });

  it("treats a completion time in the future (clock skew) as ok", () => {
    const verdict = evaluateMissedBackup(input({ asset: { lastCompletedAt: hoursAgo(-1) } }));
    expect(verdict.state).toBe("ok");
  });
});

describe("evaluateMissedBackup: an asset that has never been backed up", () => {
  it("is given frequency + grace from the moment it was first seen", () => {
    const fresh = { lastCompletedAt: null, firstSeenAt: hoursAgo(3) };
    expect(evaluateMissedBackup(input({ asset: fresh }))).toEqual({
      state: "ok",
      deadline: new Date(hoursAgo(3).getTime() + 26 * 3_600_000),
    });
  });

  it("is missed once that window passes without a backup", () => {
    const stale = { lastCompletedAt: null, firstSeenAt: hoursAgo(72) };
    const verdict = evaluateMissedBackup(input({ asset: stale }));
    expect(verdict.state).toBe("missed");
    expect(verdict).toMatchObject({ hoursOverdue: 46 });
  });
});

describe("evaluateMissedBackup: assets that are not being watched", () => {
  const overdue = { lastCompletedAt: hoursAgo(200) };

  it("suppresses an archived asset", () => {
    expect(evaluateMissedBackup(input({ asset: { ...overdue, isArchived: true } }))).toEqual({
      state: "suppressed",
      reason: "archived",
    });
  });

  it("suppresses a paused asset", () => {
    expect(evaluateMissedBackup(input({ asset: { ...overdue, isPaused: true } }))).toEqual({
      state: "suppressed",
      reason: "paused",
    });
  });

  it("suppresses a muted asset until the mute expires", () => {
    const muted = { ...overdue, mutedUntil: hoursAgo(-4) };
    expect(evaluateMissedBackup(input({ asset: muted }))).toEqual({
      state: "suppressed",
      reason: "muted",
    });

    const expired = { ...overdue, mutedUntil: hoursAgo(1) };
    expect(evaluateMissedBackup(input({ asset: expired })).state).toBe("missed");

    const expiresNow = { ...overdue, mutedUntil: NOW };
    expect(evaluateMissedBackup(input({ asset: expiresNow })).state).toBe("missed");
  });

  it("suppression wins over an unhealthy sync", () => {
    const verdict = evaluateMissedBackup(
      input({
        asset: { ...overdue, isArchived: true },
        integration: { syncStatus: "error" },
      }),
    );
    expect(verdict.state).toBe("suppressed");
  });
});

describe("evaluateMissedBackup: when the vendor data cannot be trusted", () => {
  const overdue = { lastCompletedAt: hoursAgo(200) };

  it("is unconfirmed, not missed, when the window has closed and the sync is failing", () => {
    const verdict = evaluateMissedBackup(
      input({ asset: overdue, integration: { syncStatus: "error" } }),
    );
    expect(verdict).toEqual({
      state: "unconfirmed",
      reason: "sync_failing",
      deadline: new Date(hoursAgo(200).getTime() + 26 * 3_600_000),
      lastSyncAt: minutesAgo(5),
    });
  });

  it("is indeterminate while the sync is failing but the last backup is inside its window", () => {
    const verdict = evaluateMissedBackup(input({ integration: { syncStatus: "error" } }));
    expect(verdict).toEqual({ state: "indeterminate", reason: "sync_failing" });
  });

  it("turns from indeterminate to unconfirmed exactly when the deadline passes", () => {
    const failing = { syncStatus: "error" } as const;
    const atDeadline = input({ asset: { lastCompletedAt: hoursAgo(26) }, integration: failing });
    expect(evaluateMissedBackup(atDeadline).state).toBe("indeterminate");

    const justAfter = input({
      asset: { lastCompletedAt: new Date(hoursAgo(26).getTime() - 1) },
      integration: failing,
    });
    expect(evaluateMissedBackup(justAfter).state).toBe("unconfirmed");
  });

  it("measures an asset that never had a backup from when it was first seen", () => {
    const verdict = evaluateMissedBackup(
      input({
        asset: { lastCompletedAt: null, firstSeenAt: hoursAgo(27) },
        integration: { syncStatus: "error" },
      }),
    );
    expect(verdict.state).toBe("unconfirmed");
  });

  it("is indeterminate when the integration has never synced", () => {
    const verdict = evaluateMissedBackup(
      input({ asset: overdue, integration: { syncStatus: "never", lastSyncAt: null } }),
    );
    expect(verdict).toEqual({ state: "indeterminate", reason: "never_synced" });
  });

  it("is unconfirmed when the last good sync is more than three intervals old", () => {
    // The sync is not reported as failing: nothing has run at all, as when
    // the worker is down.
    const stale = input({ asset: overdue, integration: { lastSyncAt: minutesAgo(46) } });
    expect(evaluateMissedBackup(stale)).toMatchObject({
      state: "unconfirmed",
      reason: "sync_stale",
      lastSyncAt: minutesAgo(46),
    });

    const atLimit = input({ asset: overdue, integration: { lastSyncAt: minutesAgo(45) } });
    expect(evaluateMissedBackup(atLimit).state).toBe("missed");
  });

  it("is indeterminate when the sync is stale but the last backup is inside its window", () => {
    const verdict = evaluateMissedBackup(input({ integration: { lastSyncAt: hoursAgo(5) } }));
    expect(verdict).toEqual({ state: "indeterminate", reason: "sync_stale" });
  });

  it("is unconfirmed when a sync has been stuck in progress for too long", () => {
    const verdict = evaluateMissedBackup(
      input({ asset: overdue, integration: { syncStatus: "running", lastSyncAt: hoursAgo(3) } }),
    );
    expect(verdict).toMatchObject({ state: "unconfirmed", reason: "sync_stale" });
  });

  it("never reports missed from data that is out of date", () => {
    for (const integration of [
      { syncStatus: "error" as const },
      { lastSyncAt: hoursAgo(30) },
      { syncStatus: "running" as const, lastSyncAt: hoursAgo(30) },
    ]) {
      for (const hours of [1, 25, 27, 500]) {
        const verdict = evaluateMissedBackup(
          input({ asset: { lastCompletedAt: hoursAgo(hours) }, integration }),
        );
        expect(verdict.state).not.toBe("missed");
        expect(verdict.state).not.toBe("ok");
      }
    }
  });

  it("scales the staleness limit with the sync interval", () => {
    const verdict = evaluateMissedBackup(
      input({
        asset: overdue,
        integration: { lastSyncAt: minutesAgo(100) },
        syncIntervalMinutes: 60,
      }),
    );
    expect(verdict.state).toBe("missed");
  });

  it("still judges an asset while a sync is in progress, if the last good one is recent", () => {
    const verdict = evaluateMissedBackup(
      input({ asset: overdue, integration: { syncStatus: "running" } }),
    );
    expect(verdict.state).toBe("missed");
  });

  it("does not hide a healthy asset behind a failing sync", () => {
    // Indeterminate either way: we do not claim "ok" from stale data.
    const verdict = evaluateMissedBackup(input({ integration: { syncStatus: "error" } }));
    expect(verdict.state).toBe("indeterminate");
  });
});

describe("evaluateMissedBackup: invalid configuration", () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an expected frequency of %s",
    (expectedFrequencyHours) => {
      expect(() => evaluateMissedBackup(input({ asset: { expectedFrequencyHours } }))).toThrow(
        RangeError,
      );
    },
  );

  it.each([-1, Number.NaN])("rejects a grace period of %s", (graceHours) => {
    expect(() => evaluateMissedBackup(input({ graceHours }))).toThrow(RangeError);
  });

  it("rejects a non-positive sync interval", () => {
    expect(() => evaluateMissedBackup(input({ syncIntervalMinutes: 0 }))).toThrow(RangeError);
  });
});

describe("deriveCurrentStatus", () => {
  const ok: MissedBackupVerdict = { state: "ok", deadline: NOW };
  const missed: MissedBackupVerdict = { state: "missed", deadline: NOW, hoursOverdue: 3 };

  it("is the latest result's status when nothing was missed", () => {
    expect(deriveCurrentStatus("success", ok)).toBe("success");
    expect(deriveCurrentStatus("warning", ok)).toBe("warning");
    expect(deriveCurrentStatus("failed", ok)).toBe("failed");
  });

  it("is unknown for an asset with no results yet", () => {
    expect(deriveCurrentStatus(null, ok)).toBe("unknown");
  });

  it("becomes missed when the rule says so", () => {
    expect(deriveCurrentStatus("success", missed)).toBe("missed");
    expect(deriveCurrentStatus("warning", missed)).toBe("missed");
    expect(deriveCurrentStatus(null, missed)).toBe("missed");
  });

  it("stays failed when the latest attempt failed and a backup is also overdue", () => {
    expect(deriveCurrentStatus("failed", missed)).toBe("failed");
  });

  it("does not report missed for suppressed, indeterminate or unconfirmed verdicts", () => {
    expect(
      deriveCurrentStatus("success", {
        state: "unconfirmed",
        reason: "sync_stale",
        deadline: NOW,
        lastSyncAt: NOW,
      }),
    ).toBe("success");
    expect(deriveCurrentStatus("success", { state: "suppressed", reason: "paused" })).toBe(
      "success",
    );
    expect(deriveCurrentStatus("success", { state: "indeterminate", reason: "sync_failing" })).toBe(
      "success",
    );
  });
});

describe("statusInView", () => {
  const unconfirmed: MissedBackupVerdict = {
    state: "unconfirmed",
    reason: "sync_failing",
    deadline: NOW,
    lastSyncAt: hoursAgo(30),
  };

  it("shows an asset stored as backed up or running as unknown once it is unconfirmed", () => {
    expect(statusInView("success", unconfirmed)).toBe("unknown");
    expect(statusInView("running", unconfirmed)).toBe("unknown");
    expect(statusInView("unknown", unconfirmed)).toBe("unknown");
  });

  it("keeps a stored problem: not being able to look never improves a status", () => {
    expect(statusInView("failed", unconfirmed)).toBe("failed");
    expect(statusInView("missed", unconfirmed)).toBe("missed");
    expect(statusInView("warning", unconfirmed)).toBe("warning");
  });

  it("leaves the stored status alone for every other verdict", () => {
    const others: MissedBackupVerdict[] = [
      { state: "ok", deadline: NOW },
      { state: "missed", deadline: NOW, hoursOverdue: 1 },
      { state: "suppressed", reason: "muted" },
      { state: "indeterminate", reason: "sync_failing" },
      { state: "indeterminate", reason: "never_synced" },
    ];
    for (const verdict of others) {
      for (const status of BACKUP_STATUSES) expect(statusInView(status, verdict)).toBe(status);
    }
  });
});
