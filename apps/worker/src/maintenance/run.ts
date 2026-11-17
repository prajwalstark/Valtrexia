import type { Logger } from "@valtrexia/core/server";
import type { Db, RetentionBatch } from "@valtrexia/db";
import type { RetentionPolicy } from "../config";
import { applyRetention } from "./retention";

export interface MaintenanceResult {
  retention: RetentionBatch;
}

/** Housekeeping that runs on a slow schedule, one run at a time across all worker processes. */
export async function runMaintenance(
  deps: { db: Db; logger: Logger },
  options: { retention: RetentionPolicy },
): Promise<MaintenanceResult> {
  const retention = await applyRetention(deps, options.retention);
  return { retention };
}
