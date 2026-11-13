import { describe, expect, it } from "vitest";
import { parseConfig } from "./config";

const base = {
  DATABASE_URL: "postgresql://valtrexia_app:fixture-password@localhost:5432/valtrexia",
  REDIS_URL: "redis://localhost:6379",
};

describe("worker configuration", () => {
  it("applies defaults: every 15 minutes, five at a time, a tick a minute", () => {
    expect(parseConfig(base)).toEqual({
      databaseUrl: base.DATABASE_URL,
      redisUrl: base.REDIS_URL,
      syncIntervalMinutes: 15,
      syncConcurrency: 5,
      schedulerTickSeconds: 60,
      dattoBaseUrl: undefined,
      logLevel: "info",
    });
  });

  it("reads overrides, and treats blank values as not set", () => {
    const config = parseConfig({
      ...base,
      SYNC_INTERVAL_MINUTES: "30",
      SYNC_CONCURRENCY: "2",
      SCHEDULER_TICK_SECONDS: "",
      DATTO_API_BASE_URL: "  ",
      LOG_LEVEL: "debug",
    });
    expect(config).toMatchObject({
      syncIntervalMinutes: 30,
      syncConcurrency: 2,
      schedulerTickSeconds: 60,
      dattoBaseUrl: undefined,
      logLevel: "debug",
    });
    expect(
      parseConfig({ ...base, DATTO_API_BASE_URL: "https://sandbox.example.test/v1" }).dattoBaseUrl,
    ).toBe("https://sandbox.example.test/v1");
  });

  it.each([
    ["no database URL", { REDIS_URL: base.REDIS_URL }, /DATABASE_URL/],
    ["no Redis URL", { DATABASE_URL: base.DATABASE_URL }, /REDIS_URL/],
    ["a zero interval", { ...base, SYNC_INTERVAL_MINUTES: "0" }, /SYNC_INTERVAL_MINUTES/],
    [
      "a non-numeric interval",
      { ...base, SYNC_INTERVAL_MINUTES: "often" },
      /SYNC_INTERVAL_MINUTES/,
    ],
    ["a fractional concurrency", { ...base, SYNC_CONCURRENCY: "2.5" }, /SYNC_CONCURRENCY/],
    ["an absurd concurrency", { ...base, SYNC_CONCURRENCY: "5000" }, /SYNC_CONCURRENCY/],
    [
      "a tick faster than five seconds",
      { ...base, SCHEDULER_TICK_SECONDS: "1" },
      /SCHEDULER_TICK_SECONDS/,
    ],
    [
      "a Datto URL that is not a URL",
      { ...base, DATTO_API_BASE_URL: "datto" },
      /DATTO_API_BASE_URL/,
    ],
    ["an unknown log level", { ...base, LOG_LEVEL: "loud" }, /LOG_LEVEL/],
  ])("rejects %s", (_label, env, pattern) => {
    expect(() => parseConfig(env)).toThrow(pattern);
  });

  it("reports every problem at once", () => {
    expect(() => parseConfig({ SYNC_CONCURRENCY: "0" })).toThrow(
      /DATABASE_URL[\s\S]*REDIS_URL[\s\S]*SYNC_CONCURRENCY/,
    );
  });

  it("never puts a configured value in the error", () => {
    try {
      parseConfig({
        DATABASE_URL: "postgresql://app:fixture-db-password@db:5432/x",
        REDIS_URL: "",
        DATTO_API_BASE_URL: "fixture-not-a-url-with-secret",
      });
      expect.unreachable();
    } catch (error) {
      const text = String(error);
      expect(text).not.toContain("fixture-db-password");
      expect(text).not.toContain("fixture-not-a-url-with-secret");
    }
  });
});
