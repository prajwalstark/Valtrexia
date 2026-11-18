import type {
  EmailSender,
  KeyProvider,
  Logger,
  OutboundPolicy,
  Resolver,
} from "@valtrexia/core/server";
import type { Db } from "@valtrexia/db";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { startHeartbeat, workerInstanceId } from "./heartbeat";
import {
  deliverDueNotifications,
  type DeliveryDeps,
  type DeliveryResult,
} from "./notifications/deliver";
import {
  DELIVER_JOB,
  DELIVER_SCHEDULER_ID,
  MAINTENANCE_JOB,
  MAINTENANCE_QUEUE,
  MAINTENANCE_SCHEDULER_ID,
  NOTIFICATION_QUEUE,
  parseSyncJob,
  QUEUE_PREFIX,
  redisConnection,
  SCHEDULER_QUEUE,
  SYNC_QUEUE,
  TICK_JOB,
  TICK_SCHEDULER_ID,
} from "./queues";
import type { RetentionPolicy } from "./config";
import { runMaintenance, type MaintenanceResult } from "./maintenance/run";
import { DEFAULT_RETENTION } from "./maintenance/retention";
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
  /** How often to look for notifications to send. Default 30 seconds. */
  notificationTickSeconds?: number;
  /** What tenant-supplied destinations may be. Strict unless set for local development. */
  outboundPolicy?: OutboundPolicy;
  /** How email is sent, or null when this server has no email set up. */
  emailSender?: EmailSender | null;
  dattoBaseUrl?: string | undefined;
  /** How long old data is kept. Default: decision 8's periods. */
  retention?: RetentionPolicy;
  /** How often maintenance runs. Default 6 hours. */
  maintenanceEveryHours?: number;
  /** Names this process in its heartbeat. Default: WORKER_INSTANCE_ID, else the host name. */
  instanceId?: string;
  /** Redis key prefix. Tests use their own so they never see each other's jobs. */
  prefix?: string;
  /** For tests. */
  now?: SyncDeps["now"];
  connectorFactory?: SyncDeps["connectorFactory"];
  resolver?: Resolver;
}

export interface RunningWorker {
  /** Runs one scheduler tick immediately, without waiting for the timer. */
  tickNow(): Promise<TickResult>;
  /** Sends the notifications that are due now, without waiting for the timer. */
  deliverNow(): Promise<DeliveryResult[]>;
  /** Runs maintenance (retention, tenant deletion) now, without waiting for the timer. */
  maintainNow(): Promise<MaintenanceResult>;
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
  const notificationQueue = new Queue(NOTIFICATION_QUEUE, { connection, prefix });
  const maintenanceQueue = new Queue(MAINTENANCE_QUEUE, { connection, prefix });
  const heartbeatRedis = new Redis(options.redisUrl, { maxRetriesPerRequest: 1 });
  heartbeatRedis.on("error", (error: Error) =>
    logger.warn({ errorName: error.name }, "heartbeat connection failed"),
  );

  const deliveryDeps: DeliveryDeps = {
    db,
    keyProvider: options.keyProvider,
    logger,
    outboundPolicy: options.outboundPolicy ?? {},
    emailSender: options.emailSender ?? null,
    ...(options.now ? { now: options.now } : {}),
    ...(options.resolver ? { resolver: options.resolver } : {}),
  };
  const deliver = () => deliverDueNotifications(deliveryDeps);
  const maintain = () =>
    runMaintenance({ db, logger }, { retention: options.retention ?? DEFAULT_RETENTION });

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
    ...(options.outboundPolicy ? { outboundPolicy: options.outboundPolicy } : {}),
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

  // One delivery run at a time across all worker processes: the job runs on
  // a single schedule, and each batch is claimed before it is sent.
  const notificationWorker = new Worker(
    NOTIFICATION_QUEUE,
    async () => {
      const results = await deliver();
      return { sent: results.filter((r) => r.result === "sent").length, total: results.length };
    },
    { connection, prefix, concurrency: 1 },
  );

  const maintenanceWorker = new Worker(MAINTENANCE_QUEUE, async () => maintain(), {
    connection,
    prefix,
    concurrency: 1,
  });

  for (const [name, worker] of [
    ["scheduler", schedulerWorker],
    ["sync", syncWorker],
    ["notifications", notificationWorker],
    ["maintenance", maintenanceWorker],
  ] as const) {
    // Connection-level problems (Redis restarting, for example). Without a
    // listener an "error" event would crash the process.
    worker.on("error", (error) => logger.error({ err: error, worker: name }, "worker error"));
  }
  schedulerWorker.on("failed", (_job, error) =>
    logger.error({ err: error }, "scheduler tick failed"),
  );
  maintenanceWorker.on("failed", (_job, error) =>
    logger.error({ err: error }, "maintenance failed; it runs again at its next time"),
  );

  // One schedule, stored in Redis. Starting a second worker process updates
  // it in place rather than adding another. The first tick runs straight
  // away, so a freshly started worker begins syncing without waiting.
  await schedulerQueue.upsertJobScheduler(
    TICK_SCHEDULER_ID,
    { every: options.schedulerTickSeconds * 1000 },
    { name: TICK_JOB, opts: { removeOnComplete: true, removeOnFail: 20 } },
  );

  await notificationQueue.upsertJobScheduler(
    DELIVER_SCHEDULER_ID,
    { every: (options.notificationTickSeconds ?? 30) * 1000 },
    { name: DELIVER_JOB, opts: { removeOnComplete: true, removeOnFail: 20 } },
  );

  await maintenanceQueue.upsertJobScheduler(
    MAINTENANCE_SCHEDULER_ID,
    { every: (options.maintenanceEveryHours ?? 6) * 3_600_000 },
    { name: MAINTENANCE_JOB, opts: { removeOnComplete: true, removeOnFail: 20 } },
  );

  // Started once the queues answer: a heartbeat means this process is working.
  const heartbeat = startHeartbeat(heartbeatRedis, {
    instanceId: options.instanceId ?? workerInstanceId(),
    prefix,
  });

  await Promise.all([
    maintenanceWorker.waitUntilReady(),
    schedulerWorker.waitUntilReady(),
    syncWorker.waitUntilReady(),
    notificationWorker.waitUntilReady(),
  ]);
  await heartbeat.beat();
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
    deliverNow: deliver,
    maintainNow: maintain,
    syncQueue,
    async close() {
      // Workers first: close() waits for a running sync to finish.
      await heartbeat.stop();
      heartbeatRedis.disconnect();
      await schedulerWorker.close();
      await notificationWorker.close();
      await maintenanceWorker.close();
      await syncWorker.close();
      await Promise.all([
        schedulerQueue.close(),
        syncQueue.close(),
        notificationQueue.close(),
        maintenanceQueue.close(),
      ]);
      logger.info("worker stopped");
    },
  };
}
