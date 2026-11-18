import { hostname } from "node:os";
import type { Redis } from "ioredis";
import { QUEUE_PREFIX } from "./queues";

/** How often a running worker says it is alive. */
export const HEARTBEAT_INTERVAL_MS = 30_000;
/** A heartbeat older than this means the worker is not healthy: it missed three beats. */
export const HEARTBEAT_STALE_MS = 3 * HEARTBEAT_INTERVAL_MS;

/**
 * Which worker process this is. Defaults to the host name, which is unique
 * per container; set WORKER_INSTANCE_ID when several workers share a host.
 */
export function workerInstanceId(env: Record<string, string | undefined> = process.env): string {
  return env.WORKER_INSTANCE_ID?.trim() || hostname();
}

export function heartbeatKey(instanceId: string, prefix = QUEUE_PREFIX): string {
  return `${prefix}:heartbeat:worker:${instanceId}`;
}

export interface Heartbeat {
  /** When this beat was written, in milliseconds since the epoch. */
  at: number;
  startedAt: number;
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

/** Whether a stored heartbeat is recent enough to call its worker healthy. */
export function isHeartbeatFresh(stored: string | null, now: number): boolean {
  if (!stored) return false;
  try {
    const { at } = JSON.parse(stored) as Partial<Heartbeat>;
    return typeof at === "number" && now - at >= -5_000 && now - at < HEARTBEAT_STALE_MS;
  } catch {
    return false;
  }
}
