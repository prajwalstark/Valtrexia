import { hostname } from "node:os";
import type { Redis } from "ioredis";
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_STALE_MS,
  heartbeatKey,
  type Heartbeat,
} from "@valtrexia/core/server";

export {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_STALE_MS,
  heartbeatKey,
  isHeartbeatFresh,
} from "@valtrexia/core/server";

/**
 * Which worker process this is. Defaults to the host name, which is unique
 * per container; set WORKER_INSTANCE_ID when several workers share a host.
 */
export function workerInstanceId(env: Record<string, string | undefined> = process.env): string {
  return env.WORKER_INSTANCE_ID?.trim() || hostname();
}

/**
 * Writes this worker's heartbeat now and every interval, until stopped. The
 * key expires on its own, so a worker that dies without stopping disappears.
 * Holds no names or data: an id and two times.
 */
export function startHeartbeat(
  redis: Pick<Redis, "set" | "del">,
  options: { instanceId: string; prefix?: string; now?: () => number; intervalMs?: number },
): { stop(): Promise<void>; beat(): Promise<void> } {
  const now = options.now ?? Date.now;
  const key = heartbeatKey(options.instanceId, options.prefix);
  const startedAt = now();
  const beat = async () => {
    const value: Heartbeat = { at: now(), startedAt };
    await redis.set(key, JSON.stringify(value), "PX", HEARTBEAT_STALE_MS);
  };
  const timer = setInterval(() => {
    // A missed beat is what the health check is for; it must not crash the worker.
    beat().catch(() => undefined);
  }, options.intervalMs ?? HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return {
    beat,
    async stop() {
      clearInterval(timer);
      await redis.del(key).catch(() => undefined);
    },
  };
}
