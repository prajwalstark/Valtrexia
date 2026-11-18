/**
 * Exits 0 if this container's worker has written a recent heartbeat, 1 if
 * not. For the container platform's health check:
 *
 *   node --import tsx src/scripts/healthcheck.ts
 *
 * Prints one word, never a URL or an error's details.
 */
import { Redis } from "ioredis";
import { heartbeatKey, isHeartbeatFresh, workerInstanceId } from "../heartbeat";

async function main(): Promise<number> {
  const url = process.env.REDIS_URL;
  if (!url) return 1;
  const redis = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    connectTimeout: 3_000,
    commandTimeout: 3_000,
  });
  redis.on("error", () => undefined);
  try {
    const stored = await redis.get(heartbeatKey(workerInstanceId()));
    return isHeartbeatFresh(stored, Date.now()) ? 0 : 1;
  } catch {
    return 1;
  } finally {
    redis.disconnect();
  }
}

main().then(
  (code) => {
    console.log(code === 0 ? "healthy" : "unhealthy");
    process.exitCode = code;
  },
  () => {
    console.log("unhealthy");
    process.exitCode = 1;
  },
);
