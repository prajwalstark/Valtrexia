import { describe, expect, it } from "vitest";
import {
  HEARTBEAT_STALE_MS,
  heartbeatKey,
  isHeartbeatFresh,
  startHeartbeat,
  workerInstanceId,
} from "./heartbeat";

describe("heartbeat", () => {
  const now = 1_800_000_000_000;
  const beat = (at: number) => JSON.stringify({ at, startedAt: at - 60_000 });

  it("is fresh within three missed beats, and stale after", () => {
    expect(isHeartbeatFresh(beat(now), now)).toBe(true);
    expect(isHeartbeatFresh(beat(now - HEARTBEAT_STALE_MS + 1), now)).toBe(true);
    expect(isHeartbeatFresh(beat(now - HEARTBEAT_STALE_MS), now)).toBe(false);
  });

  it("is not fresh when missing, unreadable, or from the future", () => {
    for (const stored of [null, "", "not json", "{}", '{"at":"soon"}', beat(now + 60_000)]) {
      expect(isHeartbeatFresh(stored, now)).toBe(false);
    }
  });

  it("names the instance from configuration, else the host", () => {
    expect(workerInstanceId({ WORKER_INSTANCE_ID: " worker-2 " })).toBe("worker-2");
    expect(workerInstanceId({})).toMatch(/.+/);
    expect(heartbeatKey("w1")).toBe("valtrexia:heartbeat:worker:w1");
    expect(heartbeatKey("w1", "test-x")).toBe("test-x:heartbeat:worker:w1");
  });

  it("writes with an expiry, and deletes on stop", async () => {
    const calls: unknown[][] = [];
    const redis = {
      set: (...args: unknown[]) => (calls.push(["set", ...args]), Promise.resolve("OK" as const)),
      del: (...args: unknown[]) => (calls.push(["del", ...args]), Promise.resolve(1)),
    };
    const heartbeat = startHeartbeat(redis as never, { instanceId: "w1", now: () => now });
    await heartbeat.beat();
    await heartbeat.stop();
    expect(calls).toEqual([
      [
        "set",
        "valtrexia:heartbeat:worker:w1",
        beat(now).replace(String(now - 60_000), String(now)),
        "PX",
        HEARTBEAT_STALE_MS,
      ],
      ["del", "valtrexia:heartbeat:worker:w1"],
    ]);
  });
});
