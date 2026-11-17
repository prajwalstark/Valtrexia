import "server-only";
import { cache } from "react";
import { requireTenant } from "./auth";
import { getSafeDb } from "./db";
import { getWorkspaceSettings } from "./workspace-core";

/**
 * The workspace's settings for this request, read once however many
 * components ask. Pages need the time zone to show any date.
 */
export const getWorkspace = cache(async () => {
  const session = await requireTenant();
  return getWorkspaceSettings({ db: await getSafeDb() }, session);
});
