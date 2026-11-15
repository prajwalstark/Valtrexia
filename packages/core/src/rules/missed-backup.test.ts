import { describe, expect, it } from "vitest";
import {
  deriveCurrentStatus,
  evaluateMissedBackup,
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

  it("is indeterminate, not missed, while the sync is failing", () => {
    const verdict = evaluateMissedBackup(
      input({ asset: overdue, integration: { syncStatus: "error" } }),
    );
    expect(verdict).toEqual({ state: "indeterminate", reason: "sync_failing" });
  });

  it("is indeterminate when the integration has never synced", () => {
    const verdict = evaluateMissedBackup(
      input({ asset: overdue, integration: { syncStatus: "never", lastSyncAt: null } }),
    );
    expect(verdict).toEqual({ state: "indeterminate", reason: "never_synced" });
  });

  it("is indeterminate when the last good sync is more than three intervals old", () => {
    const stale = input({ asset: overdue, integration: { lastSyncAt: minutesAgo(46) } });
    expect(evaluateMissedBackup(stale)).toEqual({ state: "indeterminate", reason: "sync_stale" });

    const atLimit = input({ asset: overdue, integration: { lastSyncAt: minutesAgo(45) } });
    expect(evaluateMissedBackup(atLimit).state).toBe("missed");
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

  it("does not report missed for suppressed or indeterminate verdicts", () => {
    expect(deriveCurrentStatus("success", { state: "suppressed", reason: "paused" })).toBe(
      "success",
    );
    expect(deriveCurrentStatus("success", { state: "indeterminate", reason: "sync_failing" })).toBe(
      "success",
    );
  });
});
