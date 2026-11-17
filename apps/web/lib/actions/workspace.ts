"use server";

import { revalidatePath } from "next/cache";
import { requireTenant } from "@/lib/auth";
import { getSafeDb } from "@/lib/db";
import { clientIp } from "@/lib/request";
import { updateWorkspaceSettings, type WorkspaceState } from "@/lib/workspace-core";

/** Owners only; the check is made in lib/workspace-core.ts. The tenant comes from the session. */
export async function updateWorkspaceAction(
  _previous: WorkspaceState,
  formData: FormData,
): Promise<WorkspaceState> {
  const session = await requireTenant();
  const state = await updateWorkspaceSettings(
    { db: await getSafeDb(), ip: await clientIp() },
    session,
    { timeZone: formData.get("timeZone"), graceHours: formData.get("graceHours") },
  );
  // Every page shows dates, and the dashboard's health depends on the grace period.
  if (state.status === "ok") revalidatePath("/", "layout");
  return state;
}
