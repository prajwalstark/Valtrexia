import { SYNC_INTERVAL_MINUTES } from "@valtrexia/core";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../worker/src/config";
import { syncIntervalMinutes } from "./sync-config";

describe("syncIntervalMinutes", () => {
  it("defaults to the product's interval when unset or blank", () => {
    expect(syncIntervalMinutes({})).toBe(SYNC_INTERVAL_MINUTES);
    expect(syncIntervalMinutes({ SYNC_INTERVAL_MINUTES: "  " })).toBe(SYNC_INTERVAL_MINUTES);
  });

  it("reads a whole number of minutes", () => {
    expect(syncIntervalMinutes({ SYNC_INTERVAL_MINUTES: "5" })).toBe(5);
    expect(syncIntervalMinutes({ SYNC_INTERVAL_MINUTES: "1440" })).toBe(1440);
  });

  it.each(["0", "-5", "1441", "7.5", "soon"])("refuses %s", (value) => {
    expect(() => syncIntervalMinutes({ SYNC_INTERVAL_MINUTES: value })).toThrow(
      /SYNC_INTERVAL_MINUTES/,
    );
  });

  it("agrees with the worker on every value, so the two never judge freshness differently", () => {
    const workerEnv = { DATABASE_URL: "postgresql://x", REDIS_URL: "redis://x" };
    for (const value of [undefined, "", "1", "15", "60", "1440", "0", "1441", "7.5", "soon"]) {
      const env = value === undefined ? {} : { SYNC_INTERVAL_MINUTES: value };
      let worker: number | "refused";
      try {
        worker = parseConfig({ ...workerEnv, ...env }).syncIntervalMinutes;
      } catch {
        worker = "refused";
      }
      let web: number | "refused";
      try {
        web = syncIntervalMinutes(env);
      } catch {
        web = "refused";
      }
      expect(web, `SYNC_INTERVAL_MINUTES=${String(value)}`).toBe(worker);
    }
  });
});
