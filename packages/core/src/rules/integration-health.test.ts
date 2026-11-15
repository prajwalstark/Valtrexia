import { describe, expect, it } from "vitest";
import {
  assessIntegrationHealth,
  SYNC_ERROR_KINDS,
  UNHEALTHY_AFTER_FAILURES,
  type IntegrationHealthInput,
} from "./integration-health";

const NOW = new Date("2026-11-12T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

/** A healthy integration, synced five minutes ago. */
function input(overrides: Partial<IntegrationHealthInput> = {}): IntegrationHealthInput {
  return {
    now: NOW,
    syncStatus: "ok",
    lastSyncAt: minutesAgo(5),
    createdAt: minutesAgo(60 * 24 * 30),
    consecutiveFailures: 0,
    failingSince: null,
    lastSyncErrorKind: null,
    syncIntervalMinutes: 15,
    ...overrides,
  };
}

describe("assessIntegrationHealth: syncing normally", () => {
  it("is healthy after a recent successful sync", () => {
    expect(assessIntegrationHealth(input())).toEqual({
      state: "healthy",
      since: null,
      needsAction: false,
    });
  });

  it("is healthy while the next sync is in progress", () => {
    expect(assessIntegrationHealth(input({ syncStatus: "running" })).state).toBe("healthy");
  });

  it("is waiting when just connected and not yet synced", () => {
    const fresh = input({ syncStatus: "never", lastSyncAt: null, createdAt: minutesAgo(2) });
    expect(assessIntegrationHealth(fresh).state).toBe("waiting");

    const firstSyncRunning = { ...fresh, syncStatus: "running" as const };
    expect(assessIntegrationHealth(firstSyncRunning).state).toBe("waiting");
  });
});

describe("assessIntegrationHealth: failing", () => {
  const failing = (overrides: Partial<IntegrationHealthInput>) =>
    input({
      syncStatus: "error",
      consecutiveFailures: 1,
      failingSince: minutesAgo(15),
      lastSyncErrorKind: "network",
      ...overrides,
    });

  it("is retrying after a failure that could be passing", () => {
    expect(assessIntegrationHealth(failing({}))).toEqual({
      state: "retrying",
      since: minutesAgo(15),
      needsAction: false,
    });
  });

  it("becomes unhealthy at the fourth failure in a row", () => {
    expect(UNHEALTHY_AFTER_FAILURES).toBe(4);
    expect(assessIntegrationHealth(failing({ consecutiveFailures: 3 })).state).toBe("retrying");
    expect(assessIntegrationHealth(failing({ consecutiveFailures: 4 })).state).toBe("unhealthy");
  });

  it.each(["auth", "credentials"] as const)(
    "is unhealthy at the first %s failure, and says someone must act",
    (kind) => {
      expect(assessIntegrationHealth(failing({ lastSyncErrorKind: kind }))).toEqual({
        state: "unhealthy",
        since: minutesAgo(15),
        needsAction: true,
      });
    },
  );

  it("does not ask for action on failures that can clear by themselves", () => {
    for (const kind of SYNC_ERROR_KINDS) {
      if (kind === "auth" || kind === "credentials") continue;
      const health = assessIntegrationHealth(
        failing({ lastSyncErrorKind: kind, consecutiveFailures: 10 }),
      );
      expect(health).toMatchObject({ state: "unhealthy", needsAction: false });
    }
  });

  it("stays failing while the next attempt is in progress", () => {
    const retryInProgress = failing({ syncStatus: "running", consecutiveFailures: 5 });
    expect(assessIntegrationHealth(retryInProgress).state).toBe("unhealthy");
  });

  it("treats an error status with no count recorded as a failure, not as healthy", () => {
    const health = assessIntegrationHealth(
      input({ syncStatus: "error", consecutiveFailures: 0, lastSyncErrorKind: null }),
    );
    expect(health.state).toBe("retrying");
  });

  it("reports failing, not stalled, when both are true", () => {
    const health = assessIntegrationHealth(failing({ lastSyncAt: minutesAgo(600) }));
    expect(health.state).toBe("retrying");
  });
});

describe("assessIntegrationHealth: nothing arriving", () => {
  it("is stalled when no sync has succeeded for more than three intervals", () => {
    expect(assessIntegrationHealth(input({ lastSyncAt: minutesAgo(45) })).state).toBe("healthy");
    expect(assessIntegrationHealth(input({ lastSyncAt: minutesAgo(46) }))).toEqual({
      state: "stalled",
      since: minutesAgo(46),
      needsAction: false,
    });
  });

  it("is stalled when a sync has been in progress for too long", () => {
    const stuck = input({ syncStatus: "running", lastSyncAt: minutesAgo(180) });
    expect(assessIntegrationHealth(stuck).state).toBe("stalled");
  });

  it("is stalled when connected long ago and never synced", () => {
    const neverSynced = input({ syncStatus: "never", lastSyncAt: null, createdAt: minutesAgo(90) });
    expect(assessIntegrationHealth(neverSynced)).toEqual({
      state: "stalled",
      since: minutesAgo(90),
      needsAction: false,
    });
  });

  it("scales with the sync interval", () => {
    const hourly = input({ lastSyncAt: minutesAgo(100), syncIntervalMinutes: 60 });
    expect(assessIntegrationHealth(hourly).state).toBe("healthy");
  });

  it("rejects a non-positive sync interval", () => {
    expect(() => assessIntegrationHealth(input({ syncIntervalMinutes: 0 }))).toThrow(RangeError);
  });
});
