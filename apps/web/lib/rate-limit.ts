import { randomUUID } from "node:crypto";

/**
 * Rate limiting by key over a sliding window.
 *
 * In production the count is kept in Redis, so every web instance shares one
 * limit. In development, without Redis configured, it is held in memory.
 */
export interface RateLimiter {
  /**
   * Records an attempt for `key`. Resolves false if it is over the limit.
   * Rejects with RateLimiterUnavailableError if the count cannot be checked.
   */
  take(key: string): Promise<boolean>;
}

/**
 * The limiter's store did not answer. Callers refuse the attempt: an
 * unlimited connection test is what the limit exists to prevent.
 */
export class RateLimiterUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("The rate limiter could not be reached.", options);
    this.name = "RateLimiterUnavailableError";
  }
}

/** A limiter held in this process's memory. For development and tests. */
export function createRateLimiter(options: {
  limit: number;
  windowMs: number;
  now?: () => number;
}): RateLimiter {
  const now = options.now ?? Date.now;
  const attempts = new Map<string, number[]>();

  return {
    async take(key) {
      const cutoff = now() - options.windowMs;
      const recent = (attempts.get(key) ?? []).filter((at) => at > cutoff);
      if (recent.length >= options.limit) {
        attempts.set(key, recent);
        return false;
      }
      recent.push(now());
      attempts.set(key, recent);

      // Keep the map from growing without bound.
      if (attempts.size > 5000) {
        for (const [other, times] of attempts) {
          if (times.every((at) => at <= cutoff)) attempts.delete(other);
        }
      }
      return true;
    },
  };
}

/** The one Redis command the limiter sends. An ioredis client satisfies it. */
export interface RedisEval {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

/**
 * Sliding window in a sorted set, checked and updated in one script so two
 * web instances cannot both take the last slot. Time comes from the Redis
 * server, so instances with different clocks still agree.
 */
const SLIDING_WINDOW = `
local key = KEYS[1]
local window = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
if redis.call('ZCARD', key) >= limit then
  redis.call('PEXPIRE', key, window)
  return 0
end
redis.call('ZADD', key, now, ARGV[3])
redis.call('PEXPIRE', key, window)
return 1
`;

/** A limiter shared by every web instance through Redis. */
export function createRedisRateLimiter(options: {
  redis: RedisEval;
  /** Names this limit, so different limits never share counts. */
  name: string;
  limit: number;
  windowMs: number;
  prefix?: string;
}): RateLimiter {
  const prefix = options.prefix ?? "valtrexia:ratelimit";
  return {
    async take(key) {
      let answer: unknown;
      try {
        answer = await options.redis.eval(
          SLIDING_WINDOW,
          1,
          `${prefix}:${options.name}:${key}`,
          options.windowMs,
          options.limit,
          randomUUID(),
        );
      } catch (cause) {
        throw new RateLimiterUnavailableError({ cause });
      }
      return answer === 1;
    },
  };
}
