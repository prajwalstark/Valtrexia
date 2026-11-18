import { describe, expect, it } from "vitest";
import { checkReadiness } from "./readiness";

const ok = () => Promise.resolve();
const fails = () => Promise.reject(new Error("connect ECONNREFUSED 10.0.0.9:5432"));
const hangs = () => new Promise<void>(() => {});

describe("readiness", () => {
  it("is ready when every check passes, with or without Redis", async () => {
    expect(await checkReadiness({ database: ok, redis: ok })).toEqual({ ready: true });
    expect(await checkReadiness({ database: ok })).toEqual({ ready: true });
  });

  it("names what failed, and nothing about why", async () => {
    const result = await checkReadiness({ database: fails, redis: ok });
    expect(result).toEqual({ ready: false, failed: ["database"] });
    expect(JSON.stringify(result)).not.toContain("10.0.0.9");
    expect(await checkReadiness({ database: fails, redis: fails })).toEqual({
      ready: false,
      failed: ["database", "redis"],
    });
  });

  it("does not wait for a check that never answers", async () => {
    const started = Date.now();
    expect(await checkReadiness({ database: ok, redis: hangs }, 50)).toEqual({
      ready: false,
      failed: ["redis"],
    });
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
