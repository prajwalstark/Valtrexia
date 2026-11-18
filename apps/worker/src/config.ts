import { SYNC_INTERVAL_MINUTES } from "@valtrexia/core";
import { z } from "zod";

const blankToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const number = (min: number, max: number, fallback: number) =>
  z.preprocess(blankToUndefined, z.coerce.number().int().min(min).max(max).default(fallback));

const schema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  /** How often each integration is synced. */
  SYNC_INTERVAL_MINUTES: number(1, 24 * 60, SYNC_INTERVAL_MINUTES),
  /** Integrations synced at the same time by this process. */
  SYNC_CONCURRENCY: number(1, 50, 5),
  /** How often the scheduler looks for integrations that are due. */
  SCHEDULER_TICK_SECONDS: number(5, 3600, 60),
  /** How often the worker looks for notifications to send. */
  NOTIFICATION_TICK_SECONDS: number(5, 3600, 30),
  /** Raw vendor payloads are emptied after this many days. */
  RETENTION_RAW_PAYLOAD_DAYS: number(7, 3650, 90),
  /** Backup results are deleted after this many days (13 months). */
  RETENTION_RESULT_DAYS: number(30, 3650, 395),
  /** Audit entries are deleted after this many days (24 months). */
  RETENTION_AUDIT_DAYS: number(90, 3650, 730),
  DATTO_API_BASE_URL: z.preprocess(blankToUndefined, z.url().optional()),
  LOG_LEVEL: z.preprocess(
    blankToUndefined,
    z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  ),
});

export interface WorkerConfig {
  databaseUrl: string;
  redisUrl: string;
  syncIntervalMinutes: number;
  syncConcurrency: number;
  schedulerTickSeconds: number;
  notificationTickSeconds: number;
  dattoBaseUrl: string | undefined;
  logLevel: string;
  retention: RetentionPolicy;
}

export interface RetentionPolicy {
  payloadDays: number;
  resultDays: number;
  auditDays: number;
}

/**
 * Reads the worker's configuration from the environment and fails with a
 * readable message if something is missing or malformed. The message names
 * the variable and the problem, never the value: a mistyped connection
 * string should not end up in a log.
 */
export function parseConfig(env: Record<string, string | undefined>): WorkerConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`,
    );
    throw new Error(`Invalid worker configuration.\n  ${problems.join("\n  ")}`);
  }
  const value = parsed.data;
  return {
    databaseUrl: value.DATABASE_URL,
    redisUrl: value.REDIS_URL,
    syncIntervalMinutes: value.SYNC_INTERVAL_MINUTES,
    syncConcurrency: value.SYNC_CONCURRENCY,
    schedulerTickSeconds: value.SCHEDULER_TICK_SECONDS,
    notificationTickSeconds: value.NOTIFICATION_TICK_SECONDS,
    dattoBaseUrl: value.DATTO_API_BASE_URL,
    logLevel: value.LOG_LEVEL,
    retention: {
      payloadDays: value.RETENTION_RAW_PAYLOAD_DAYS,
      resultDays: value.RETENTION_RESULT_DAYS,
      auditDays: value.RETENTION_AUDIT_DAYS,
    },
  };
}
