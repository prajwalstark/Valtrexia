import type { Logger } from "@valtrexia/core/server";
import type { Db, RetentionBatch } from "@valtrexia/db";
import type { RetentionPolicy } from "../config";
import { applyRetention } from "./retention";

export interface MaintenanceResult {
  retention: RetentionBatch;
  /** Workspaces deleted because their hold had passed. */
  tenantsDeleted: string[];
}

/** Housekeeping that runs on a slow schedule, one run at a time across all worker processes. */
export async function runMaintenance(
  deps: { db: Db; logger: Logger },
  options: { retention: RetentionPolicy },
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
  const retention = await applyRetention(deps, options.retention);
  return { retention, tenantsDeleted };
}
