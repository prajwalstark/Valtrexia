/**
 * A sliding-window rate limiter held in memory.
 *
 * It limits per process. With several web instances the effective limit is
 * multiplied by their number, which is acceptable for its one use so far:
 * stopping the connection test from being used to try credentials against a
 * vendor at speed. Move it to Redis if a tighter bound is ever needed.
 */
export interface RateLimiter {
  /** Records an attempt for `key`. Returns false if it is over the limit. */
  take(key: string): boolean;
}

export function createRateLimiter(options: {
  limit: number;
  windowMs: number;
  now?: () => number;
}): RateLimiter {
  const now = options.now ?? Date.now;
  const attempts = new Map<string, number[]>();

  return {
    take(key) {
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
