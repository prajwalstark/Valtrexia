import "server-only";
import { cache } from "react";
import { requireTenant } from "./auth";
import { getFleetOverview } from "./dashboard-core";
import { getSafeDb } from "./db";

/**
 * The fleet overview for this request. The layout's status strip and the
 * dashboard page both need it; React `cache` makes that one query set.
 */
export const getFleet = cache(async () => {
  const session = await requireTenant();
  const now = new Date();
  return { now, overview: await getFleetOverview({ db: await getSafeDb() }, session, now) };
});
