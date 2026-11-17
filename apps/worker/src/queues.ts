import type { ConnectionOptions } from "bullmq";
import { z } from "zod";

/** Sync jobs: one per integration that is due. */
export const SYNC_QUEUE = "sync";
/** The repeating tick that finds due integrations and fills the sync queue. */
export const SCHEDULER_QUEUE = "scheduler";
/** Every key this application writes to Redis starts with this. */
export const QUEUE_PREFIX = "valtrexia";

/** The repeating job that sends notifications that are due. */
export const NOTIFICATION_QUEUE = "notifications";

/** The repeating job that applies retention and deletes offboarded tenants. */
export const MAINTENANCE_QUEUE = "maintenance";

export const SYNC_JOB = "sync-integration";
export const MAINTENANCE_JOB = "maintain";
export const MAINTENANCE_SCHEDULER_ID = "maintenance";
export const DELIVER_JOB = "deliver";
export const DELIVER_SCHEDULER_ID = "deliver-notifications";
export const TICK_JOB = "tick";
export const TICK_SCHEDULER_ID = "find-due-integrations";

const syncJobSchema = z.strictObject({
  tenantId: z.uuid(),
  integrationId: z.uuid(),
});
export type SyncJobData = z.infer<typeof syncJobSchema>;

/** Job data comes back out of Redis, so it is checked before it is trusted. */
export function parseSyncJob(data: unknown): SyncJobData {
  return syncJobSchema.parse(data);
}

/**
 * One job per integration can exist at a time. BullMQ ignores an `add` whose
 * id is already waiting or running, which is what stops an integration from
 * being synced twice at once. (BullMQ does not allow ":" in a custom id.)
 */
export function syncJobId(integrationId: string): string {
  return `sync-${integrationId}`;
}

export function redisConnection(url: string): ConnectionOptions {
  return {
    url,
    // Required by BullMQ for the blocking connection workers hold open.
    maxRetriesPerRequest: null,
  };
}
