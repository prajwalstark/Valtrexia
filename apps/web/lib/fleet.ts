import "server-only";
import { cache } from "react";
import { requireTenant } from "./auth";
import { getFleetOverview } from "./dashboard-core";
import { getSafeDb } from "./db";
import { syncIntervalMinutes } from "./sync-config";

/**
 * The fleet overview for this request. The layout's status strip and the
 * dashboard page both need it; React `cache` makes that one query set.
 */
export const getFleet = cache(async () => {
  const session = await requireTenant();
  const now = new Date();
  const deps = { db: await getSafeDb(), syncIntervalMinutes: syncIntervalMinutes() };
  return { now, session, overview: await getFleetOverview(deps, session, now) };
});
