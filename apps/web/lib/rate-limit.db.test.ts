import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRedisRateLimiter } from "./rate-limit";

// Against a real Redis: the limit must hold across web instances, which the
// in-memory limiter cannot do.
const url = process.env.REDIS_URL ?? "redis://localhost:6379";
let redis: Redis;
let other: Redis;
beforeAll(() => {
  redis = new Redis(url, { lazyConnect: true });
  other = new Redis(url, { lazyConnect: true });
});
afterAll(async () => {
  await redis.quit();
  await other.quit();
});

const prefix = `valtrexia-test:${randomUUID()}`;

describe("rate limiter (Redis)", () => {
  it("shares one limit between instances", async () => {
    const options = { name: "connection-test", limit: 3, windowMs: 60_000, prefix };
    const a = createRedisRateLimiter({ redis, ...options });
    const b = createRedisRateLimiter({ redis: other, ...options });
    const answers = [];
    for (const limiter of [a, b, a, b, a]) answers.push(await limiter.take("tenant-1"));
    expect(answers).toEqual([true, true, true, false, false]);
    // Another tenant has its own count.
    expect(await b.take("tenant-2")).toBe(true);
  });

  it("does not let simultaneous attempts exceed the limit", async () => {
    const limiter = createRedisRateLimiter({
      redis,
      name: "burst",
      limit: 5,
      windowMs: 60_000,
      prefix,
    });
    const answers = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        createRedisRateLimiter({
          redis: i % 2 ? redis : other,
          name: "burst",
          limit: 5,
          windowMs: 60_000,
          prefix,
        }).take("t"),
      ),
    );
    expect(answers.filter(Boolean)).toHaveLength(5);
    expect(await limiter.take("t")).toBe(false);
  });

  it("lets attempts through again once the window has passed, and expires its keys", async () => {
    const limiter = createRedisRateLimiter({
      redis,
      name: "short",
      limit: 1,
      windowMs: 300,
      prefix,
    });
    expect(await limiter.take("t")).toBe(true);
    expect(await limiter.take("t")).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await limiter.take("t")).toBe(true);
    const ttl = await redis.pttl(`${prefix}:short:t`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(300);
  });

  it("keeps different limits apart", async () => {
    const one = createRedisRateLimiter({ redis, name: "one", limit: 1, windowMs: 60_000, prefix });
    const two = createRedisRateLimiter({ redis, name: "two", limit: 1, windowMs: 60_000, prefix });
    expect(await one.take("t")).toBe(true);
    expect(await two.take("t")).toBe(true);
  });
});
