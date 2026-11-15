import { describe, expect, it } from "vitest";
import { createRateLimiter } from "./rate-limit";

describe("rate limiter", () => {
  it("allows up to the limit inside the window, then refuses", () => {
    const clock = 1_000_000;
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000, now: () => clock });
    expect([1, 2, 3, 4, 5].map(() => limiter.take("tenant-a"))).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
  });

  it("counts each key separately", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: () => 0 });
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("b")).toBe(true);
    expect(limiter.take("a")).toBe(false);
  });

  it("lets attempts through again as old ones leave the window", () => {
    let clock = 0;
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, now: () => clock });
    expect(limiter.take("a")).toBe(true); // t=0
    clock = 30_000;
    expect(limiter.take("a")).toBe(true); // t=30s
    expect(limiter.take("a")).toBe(false);
    clock = 60_001; // the first attempt has aged out, the second has not
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(false);
    clock = 200_000;
    expect(limiter.take("a")).toBe(true);
  });

  it("does not let refused attempts extend the lockout", () => {
    let clock = 0;
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: () => clock });
    limiter.take("a");
    for (clock = 1000; clock < 60_000; clock += 1000) expect(limiter.take("a")).toBe(false);
    clock = 60_001;
    expect(limiter.take("a")).toBe(true);
  });
});
