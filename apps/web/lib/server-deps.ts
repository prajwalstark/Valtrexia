import "server-only";
import { isMockAllowed } from "@valtrexia/connectors";
import {
  assertProductionTransport,
  createLogger,
  outboundPolicyFromEnv,
} from "@valtrexia/core/server";
import { Redis } from "ioredis";
import { getSafeDb } from "./db";
import type { IntegrationDeps } from "./integrations-core";
import { getKeyProvider } from "./keys";
import { createRateLimiter, createRedisRateLimiter, type RateLimiter } from "./rate-limit";
import { clientIp } from "./request";

const logger = createLogger({ name: "web" });

// Ten connection tests per tenant per minute: plenty for a person correcting
// a typo, far too few to try keys against a vendor in bulk.
const CONNECTION_TESTS = { name: "connection-test", limit: 10, windowMs: 60_000 };

let connectionTestLimiter: RateLimiter | undefined;
let redisClient: Redis | undefined;

/**
 * This server's Redis connection, or null when REDIS_URL is not set, which is
 * allowed in development only. Created on first use, and shared.
 */
function getRedis(): Redis | null {
  if (redisClient) return redisClient;
  const url = process.env.REDIS_URL;
  if (!url) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("REDIS_URL is not set. The web app needs Redis in production.");
    }
    return null;
  }
  assertProductionTransport(process.env, { redis: true });
  redisClient = new Redis(url, {
    lazyConnect: true,
    // Fail a command within seconds rather than queueing it while Redis is away.
    maxRetriesPerRequest: 1,
    commandTimeout: 2_000,
    connectTimeout: 2_000,
  });
  // Without a listener a connection error would crash the process. The URL is never logged.
  redisClient.on("error", (error: Error) =>
    logger.warn({ errorName: error.name }, "Redis connection failed"),
  );
  return redisClient;
}

/**
 * Shared through Redis when REDIS_URL is set, so every web instance counts
 * against one limit; required in production. Without it, in development, the
 * count is kept in this process.
 */
function getConnectionTestLimiter(): RateLimiter {
  if (connectionTestLimiter) return connectionTestLimiter;
  const redis = getRedis();
  connectionTestLimiter = redis
    ? createRedisRateLimiter({ redis, ...CONNECTION_TESTS })
    : createRateLimiter(CONNECTION_TESTS);
  return connectionTestLimiter;
}

/** Pings Redis, for the readiness check. Undefined when this server has no Redis (development). */
export function redisPing(): (() => Promise<void>) | undefined {
  const redis = getRedis();
  if (!redis) return undefined;
  return async () => {
    if ((await redis.ping()) !== "PONG") throw new Error("unexpected reply");
  };
}

/** What the integrations logic needs, assembled from configuration for one request. */
export async function integrationDeps(): Promise<IntegrationDeps> {
  // Server configuration only. This must never be taken from a request.
  const dattoBaseUrl = process.env.DATTO_API_BASE_URL;
  return {
    db: await getSafeDb(),
    keyProvider: getKeyProvider(),
    connectorDeps: {
      allowMock: isMockAllowed(process.env),
      logger,
      // A person is waiting: one retry, not the sync job's patient four.
      maxRetries: 1,
      // A VSPC console's address comes from a person. Never relaxed in production.
      outboundPolicy: outboundPolicyFromEnv(process.env),
      ...(dattoBaseUrl ? { dattoBaseUrl } : {}),
    },
    limiter: getConnectionTestLimiter(),
    logger,
    ip: await clientIp(),
  };
}

/** What the notification settings need, assembled from configuration for one request. */
export async function notificationDeps() {
  return {
    db: await getSafeDb(),
    keyProvider: getKeyProvider(),
    // Server configuration only. Never relaxed in production, whatever is set.
    outboundPolicy: outboundPolicyFromEnv(process.env),
    // The web app and the worker must be given the same EMAIL_PROVIDER.
    emailAvailable: emailConfigured(process.env),
    ip: await clientIp(),
  };
}

/** Whether this server can send email. The worker decides how; here it only matters whether. */
export function emailConfigured(env: Record<string, string | undefined>): boolean {
  return (env.EMAIL_PROVIDER?.trim() ?? "") !== "";
}
