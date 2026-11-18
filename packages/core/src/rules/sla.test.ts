import { describe, expect, it } from "vitest";
import { evaluateMissedBackup } from "./missed-backup";
import { effectiveSlaHours, evaluateSla, type SlaInput } from "./sla";

const NOW = new Date("2026-11-12T12:00:00.000Z");
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

/** A daily asset with a 72-hour SLA, last backed up 6 hours ago, on a healthy integration. */
function input(overrides: {
  asset?: Partial<SlaInput["asset"]>;
  integration?: Partial<SlaInput["integration"]>;
  graceHours?: number;
  syncIntervalMinutes?: number;
}): SlaInput {
  return {
    now: NOW,
    asset: {
      slaHours: 72,
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

describe("evaluateSla: the limit", () => {
  it("is ok while the last completed backup is inside the SLA", () => {
    expect(evaluateSla(input({}))).toEqual({
      state: "ok",
      deadline: new Date("2026-11-15T06:00:00.000Z"),
      effectiveSlaHours: 72,
    });
  });

  it("is ok exactly at the limit and breached one millisecond after", () => {
    expect(evaluateSla(input({ asset: { lastCompletedAt: hoursAgo(72) } })).state).toBe("ok");
    const justAfter = input({ asset: { lastCompletedAt: new Date(hoursAgo(72).getTime() - 1) } });
    expect(evaluateSla(justAfter).state).toBe("breached");
  });

  it("reports when the SLA was crossed and how far past it we are", () => {
    expect(evaluateSla(input({ asset: { lastCompletedAt: hoursAgo(100) } }))).toEqual({
      state: "breached",
      deadline: hoursAgo(28),
      hoursOverdue: 28,
      effectiveSlaHours: 72,
    });
  });

  it("does not add the grace period to an SLA longer than the backup window", () => {
    const verdict = evaluateSla(
      input({ asset: { lastCompletedAt: hoursAgo(73) }, graceHours: 12 }),
    );
    expect(verdict.state).toBe("breached");
  });

  it("measures an asset that has never been backed up from when it was first seen", () => {
    const never = (firstSeenHoursAgo: number) =>
      evaluateSla(
        input({ asset: { lastCompletedAt: null, firstSeenAt: hoursAgo(firstSeenHoursAgo) } }),
      ).state;
    expect(never(71)).toBe("ok");
    expect(never(73)).toBe("breached");
  });

  it("does not care why there is no backup: only a completed one resets it", () => {
    // The caller passes the last *completed* backup. Three days of nightly
    // failures and three days of silence look the same here.
    const verdict = evaluateSla(input({ asset: { lastCompletedAt: hoursAgo(80) } }));
    expect(verdict.state).toBe("breached");
  });
});

describe("evaluateSla: an SLA shorter than the backup window", () => {
  it("applies the window instead, so a weekly asset is not stale every week", () => {
    const weekly = { slaHours: 72, expectedFrequencyHours: 168 };
    expect(effectiveSlaHours(weekly, 2)).toBe(170);

    const fourDays = evaluateSla(input({ asset: { ...weekly, lastCompletedAt: hoursAgo(96) } }));
    expect(fourDays).toMatchObject({ state: "ok", effectiveSlaHours: 170 });

    const eightDays = evaluateSla(input({ asset: { ...weekly, lastCompletedAt: hoursAgo(192) } }));
    expect(eightDays).toMatchObject({
      state: "breached",
      effectiveSlaHours: 170,
      hoursOverdue: 22,
    });
  });

  it("uses the configured SLA whenever it is the longer of the two", () => {
    expect(effectiveSlaHours({ slaHours: 72, expectedFrequencyHours: 24 }, 2)).toBe(72);
    expect(effectiveSlaHours({ slaHours: 24, expectedFrequencyHours: 24 }, 2)).toBe(26);
    expect(effectiveSlaHours({ slaHours: 26, expectedFrequencyHours: 24 }, 2)).toBe(26);
  });

  it("is never breached before the backup is also missed", () => {
    // Every combination: if the SLA rule says breached, the missed rule says missed.
    for (const slaHours of [1, 12, 24, 26, 48, 72, 200]) {
      for (const expectedFrequencyHours of [1, 4, 24, 168]) {
        for (const graceHours of [0, 2, 12]) {
          for (const hours of [0.5, 5, 25, 27, 50, 73, 171, 181, 400]) {
            const asset = { slaHours, expectedFrequencyHours, lastCompletedAt: hoursAgo(hours) };
            const sla = evaluateSla(input({ asset, graceHours }));
            const missed = evaluateMissedBackup(input({ asset, graceHours }));
            if (sla.state === "breached") expect(missed.state).toBe("missed");
          }
        }
      }
    }
  });
});

describe("evaluateSla: assets that are not being watched", () => {
  const overdue = { lastCompletedAt: hoursAgo(500) };

  it.each([
    ["archived", { isArchived: true }],
    ["paused", { isPaused: true }],
    ["muted", { mutedUntil: new Date(NOW.getTime() + 60_000) }],
  ] as const)("is suppressed when %s, however overdue", (reason, flags) => {
    expect(evaluateSla(input({ asset: { ...overdue, ...flags } }))).toEqual({
      state: "suppressed",
      reason,
    });
  });

  it("judges the asset again once a mute has ended", () => {
    const verdict = evaluateSla(input({ asset: { ...overdue, mutedUntil: minutesAgo(1) } }));
    expect(verdict.state).toBe("breached");
  });

  it("is suppressed rather than indeterminate when both apply", () => {
    const verdict = evaluateSla(
      input({ asset: { ...overdue, isPaused: true }, integration: { syncStatus: "error" } }),
    );
    expect(verdict.state).toBe("suppressed");
  });
});

describe("evaluateSla: when the vendor data cannot be trusted", () => {
  const overdue = { lastCompletedAt: hoursAgo(500) };

  it.each([
    ["sync_failing", { syncStatus: "error" }],
    ["never_synced", { syncStatus: "never", lastSyncAt: null }],
    ["sync_stale", { lastSyncAt: minutesAgo(46) }],
  ] as const)("is indeterminate (%s), never breached", (reason, integration) => {
    expect(evaluateSla(input({ asset: overdue, integration }))).toEqual({
      state: "indeterminate",
      reason,
    });
  });

  it("never reports ok from data that is out of date either", () => {
    expect(evaluateSla(input({ integration: { syncStatus: "error" } })).state).toBe(
      "indeterminate",
    );
  });

  it("judges while a sync is in progress, if the last good one is recent", () => {
    const verdict = evaluateSla(input({ asset: overdue, integration: { syncStatus: "running" } }));
    expect(verdict.state).toBe("breached");
  });
});

describe("evaluateSla: invalid configuration", () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects an SLA of %s", (slaHours) => {
    expect(() => evaluateSla(input({ asset: { slaHours } }))).toThrow(RangeError);
  });

  it("rejects a non-positive frequency, a negative grace period and a non-positive interval", () => {
    expect(() => evaluateSla(input({ asset: { expectedFrequencyHours: 0 } }))).toThrow(RangeError);
    expect(() => evaluateSla(input({ graceHours: -1 }))).toThrow(RangeError);
    expect(() => evaluateSla(input({ syncIntervalMinutes: 0 }))).toThrow(RangeError);
  });
});
