import type { Logger } from "@valtrexia/core/server";
import type { Db } from "@valtrexia/db";
import type { Queue } from "bullmq";
import { SYNC_JOB, syncJobId, type SyncJobData } from "./queues";

export interface TickResult {
  /** Integrations whose last sync started longer ago than the interval. */
  due: number;
  /** Of those, how many were queued now. The rest were already queued or running. */
  enqueued: number;
}

/**
 * One scheduler tick: find integrations that are due and queue a sync for
 * each one that is not already queued.
 *
 * The database is the source of truth for what is due. There is no schedule
 * per integration in Redis to drift out of step when an integration is added,
 * replaced or removed: if a row is due it is found here, and if it is gone it
 * is simply never found again.
 *
 * Finding what is due is the system's one cross-tenant read. It goes through
 * `list_due_integrations`, which returns ids only.
 */
export async function enqueueDueSyncs(deps: {
  db: Pick<Db, "listDueIntegrations">;
  queue: Queue;
  intervalMinutes: number;
  logger: Logger;
}): Promise<TickResult> {
  const due = await deps.db.listDueIntegrations({ intervalMinutes: deps.intervalMinutes });

  let enqueued = 0;
  for (const { tenantId, integrationId } of due) {
    const jobId = syncJobId(integrationId);
    if (await deps.queue.getJob(jobId)) continue; // still waiting or running from an earlier tick

    const data: SyncJobData = { tenantId, integrationId };
    await deps.queue.add(SYNC_JOB, data, {
      jobId,
      // The HTTP layer retries transient vendor errors itself. A sync that
      // still fails is recorded on the integration and tried again when it is
      // next due, rather than retried in a tight loop here.
      attempts: 1,
      // Finished jobs are removed so the id is free for the next sync. The
      // outcome that matters is on the integration row, not in Redis.
      removeOnComplete: true,
      removeOnFail: true,
    });
    enqueued += 1;
  }

  if (due.length > 0) deps.logger.debug({ due: due.length, enqueued }, "scheduler tick");
  return { due: due.length, enqueued };
}
