import { describe, expect, it } from "vitest";
import {
  createRateLimiter,
  createRedisRateLimiter,
  RateLimiterUnavailableError,
} from "./rate-limit";

describe("rate limiter (in memory)", () => {
  it("allows up to the limit inside the window, then refuses", async () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000, now: () => 1_000_000 });
    const answers = [];
    for (let i = 0; i < 5; i += 1) answers.push(await limiter.take("tenant-a"));
    expect(answers).toEqual([true, true, true, false, false]);
  });

  it("counts each key separately", async () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: () => 0 });
    expect(await limiter.take("a")).toBe(true);
    expect(await limiter.take("b")).toBe(true);
    expect(await limiter.take("a")).toBe(false);
  });

  it("lets attempts through again as old ones leave the window", async () => {
    let clock = 0;
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, now: () => clock });
    expect(await limiter.take("a")).toBe(true); // t=0
    clock = 30_000;
    expect(await limiter.take("a")).toBe(true); // t=30s
    expect(await limiter.take("a")).toBe(false);
    clock = 60_001; // the first attempt has aged out, the second has not
    expect(await limiter.take("a")).toBe(true);
    expect(await limiter.take("a")).toBe(false);
    clock = 200_000;
    expect(await limiter.take("a")).toBe(true);
  });

  it("does not let refused attempts extend the lockout", async () => {
    let clock = 0;
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: () => clock });
    await limiter.take("a");
    for (clock = 1000; clock < 60_000; clock += 1000) expect(await limiter.take("a")).toBe(false);
    clock = 60_001;
    expect(await limiter.take("a")).toBe(true);
  });
});

describe("rate limiter (Redis), when Redis fails", () => {
  it("reports itself unavailable rather than allowing the attempt", async () => {
    const limiter = createRedisRateLimiter({
      redis: { eval: () => Promise.reject(new Error("connect ECONNREFUSED 10.0.0.5:6379")) },
      name: "test",
      limit: 10,
      windowMs: 60_000,
    });
    const error = await limiter.take("a").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimiterUnavailableError);
    expect(String(error)).not.toContain("10.0.0.5");
  });
});
