import type { KeyProvider, Logger } from "@valtrexia/core/server";
import type { Db } from "@valtrexia/db";
import { Queue, Worker } from "bullmq";
import {
  parseSyncJob,
  QUEUE_PREFIX,
  redisConnection,
  SCHEDULER_QUEUE,
  SYNC_QUEUE,
  TICK_JOB,
  TICK_SCHEDULER_ID,
} from "./queues";
import { enqueueDueSyncs, type TickResult } from "./scheduler";
import { IntegrationNotFoundError, syncIntegration, type SyncDeps } from "./sync/sync-integration";

export interface WorkerOptions {
  db: Db;
  keyProvider: KeyProvider;
  logger: Logger;
  redisUrl: string;
  allowMock: boolean;
  syncIntervalMinutes: number;
  syncConcurrency: number;
  schedulerTickSeconds: number;
  dattoBaseUrl?: string | undefined;
  /** Redis key prefix. Tests use their own so they never see each other's jobs. */
  prefix?: string;
  /** For tests. */
  now?: SyncDeps["now"];
  connectorFactory?: SyncDeps["connectorFactory"];
}

export interface RunningWorker {
  /** Runs one scheduler tick immediately, without waiting for the timer. */
  tickNow(): Promise<TickResult>;
  /** The sync queue, for inspection. */
  syncQueue: Queue;
  /** Stops taking new work, lets running syncs finish, and closes connections. */
  close(): Promise<void>;
}

/**
 * Starts the background worker:
 *
 *   - a repeating scheduler tick that queues a sync for every due integration;
 *   - a pool that runs those syncs, a few at a time.
 *
 * Any number of worker processes can run at once. The tick is a single
 * schedule held in Redis, not one per process, and a sync job's id is its
 * integration's id, so an integration is never synced by two processes at
 * the same time.
 */
export async function startWorker(options: WorkerOptions): Promise<RunningWorker> {
  const { db, logger } = options;
  const connection = redisConnection(options.redisUrl);
  const prefix = options.prefix ?? QUEUE_PREFIX;

  const syncQueue = new Queue(SYNC_QUEUE, { connection, prefix });
  const schedulerQueue = new Queue(SCHEDULER_QUEUE, { connection, prefix });

  const tick = () =>
    enqueueDueSyncs({
      db,
      queue: syncQueue,
      intervalMinutes: options.syncIntervalMinutes,
      logger,
    });

  const syncDeps: SyncDeps = {
    db,
    keyProvider: options.keyProvider,
    logger,
    allowMock: options.allowMock,
    syncIntervalMinutes: options.syncIntervalMinutes,
    ...(options.dattoBaseUrl ? { dattoBaseUrl: options.dattoBaseUrl } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.connectorFactory ? { connectorFactory: options.connectorFactory } : {}),
  };

  const schedulerWorker = new Worker(SCHEDULER_QUEUE, async () => tick(), {
    connection,
    prefix,
    concurrency: 1,
  });

  const syncWorker = new Worker(
    SYNC_QUEUE,
    async (job) => {
      const target = parseSyncJob(job.data);
      try {
        const summary = await syncIntegration(syncDeps, target);
        return { assets: summary.assets, resultsCreated: summary.resultsCreated };
      } catch (error) {
        // Disconnected between being queued and being run: nothing to do.
        if (error instanceof IntegrationNotFoundError) {
          logger.info(
            { integrationId: target.integrationId },
            "integration is gone; skipping sync",
          );
          return { skipped: true };
        }
        // syncIntegration has already logged the failure and recorded it on
        // the integration. Rethrow so the job is marked failed and removed.
        throw error;
      }
    },
    { connection, prefix, concurrency: options.syncConcurrency },
  );

  for (const [name, worker] of [
    ["scheduler", schedulerWorker],
    ["sync", syncWorker],
  ] as const) {
    // Connection-level problems (Redis restarting, for example). Without a
    // listener an "error" event would crash the process.
    worker.on("error", (error) => logger.error({ err: error, worker: name }, "worker error"));
  }
  schedulerWorker.on("failed", (_job, error) =>
    logger.error({ err: error }, "scheduler tick failed"),
  );

  // One schedule, stored in Redis. Starting a second worker process updates
  // it in place rather than adding another. The first tick runs straight
  // away, so a freshly started worker begins syncing without waiting.
  await schedulerQueue.upsertJobScheduler(
    TICK_SCHEDULER_ID,
    { every: options.schedulerTickSeconds * 1000 },
    { name: TICK_JOB, opts: { removeOnComplete: true, removeOnFail: 20 } },
  );

  await Promise.all([schedulerWorker.waitUntilReady(), syncWorker.waitUntilReady()]);
  logger.info(
    {
      syncIntervalMinutes: options.syncIntervalMinutes,
      syncConcurrency: options.syncConcurrency,
      schedulerTickSeconds: options.schedulerTickSeconds,
    },
    "worker started",
  );

  return {
    tickNow: tick,
    syncQueue,
    async close() {
      // Workers first: close() waits for a running sync to finish.
      await schedulerWorker.close();
      await syncWorker.close();
      await Promise.all([schedulerQueue.close(), syncQueue.close()]);
      logger.info("worker stopped");
    },
  };
}
