import type { Logger } from "@valtrexia/core/server";
import type { Db, RetentionBatch } from "@valtrexia/db";
import type { RetentionPolicy } from "../config";
import { queueMonthlyDigests, type DigestResult } from "../reports/digest";
import { applyRetention } from "./retention";

export interface MaintenanceResult {
  retention: RetentionBatch;
  /** Workspaces deleted because their hold had passed. */
  tenantsDeleted: string[];
  /** Monthly summaries queued. Null when turned off. */
  digests: DigestResult | null;
}

/** Housekeeping that runs on a slow schedule, one run at a time across all worker processes. */
export async function runMaintenance(
  deps: { db: Db; logger: Logger; now?: () => Date },
  options: {
    retention: RetentionPolicy;
    /** Whether to queue the monthly summaries. Default true. */
    monthlyReports?: boolean;
  },
): Promise<MaintenanceResult> {
  const tenantsDeleted: string[] = [];
  // A few at a time: each deletion cascades through everything the tenant owns.
  for (let round = 0; round < 20; round += 1) {
    const deleted = await deps.db.purgeDueTenants({ limit: 5 });
    tenantsDeleted.push(...deleted);
    if (deleted.length < 5) break;
  }
  for (const tenantId of tenantsDeleted) {
    deps.logger.info({ tenantId }, "workspace deleted after its hold");
  }
  // Before retention, so a long retention run does not hold up the summaries.
  const digests = options.monthlyReports === false ? null : await queueMonthlyDigests(deps);
  const retention = await applyRetention(deps, options.retention);
  return { retention, tenantsDeleted, digests };
}
