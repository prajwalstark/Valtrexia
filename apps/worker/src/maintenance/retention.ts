import type { Logger } from "@valtrexia/core/server";
import type { Db, RetentionBatch } from "@valtrexia/db";
import type { RetentionPolicy } from "../config";

/** The default periods, from decision 8: payloads 90 days, results 13 months, audit 24 months. */
export const DEFAULT_RETENTION: RetentionPolicy = {
  payloadDays: 90,
  resultDays: 395,
  auditDays: 730,
};

/**
 * Removes data older than the retention periods, across all tenants, in
 * batches so no statement holds locks for long. Stops after `maxBatches`
 * and carries on at the next run if there is more.
 */
export async function applyRetention(
  deps: { db: Db; logger: Logger },
  policy: RetentionPolicy,
  options: { batchSize?: number; maxBatches?: number } = {},
): Promise<RetentionBatch> {
  const batchSize = options.batchSize ?? 5000;
  const maxBatches = options.maxBatches ?? 100;
  const total: RetentionBatch = { payloadsCleared: 0, resultsDeleted: 0, auditDeleted: 0 };
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const done = await deps.db.applyRetention({ ...policy, batchSize });
    total.payloadsCleared += done.payloadsCleared;
    total.resultsDeleted += done.resultsDeleted;
    total.auditDeleted += done.auditDeleted;
    if (Math.max(done.payloadsCleared, done.resultsDeleted, done.auditDeleted) < batchSize) break;
  }
  deps.logger.info({ ...total, ...policy }, "retention applied");
  return total;
}
