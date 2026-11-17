"use server";

import { revalidatePath } from "next/cache";
import { requireTenant } from "@/lib/auth";
import { getSafeDb } from "@/lib/db";
import { clientIp } from "@/lib/request";
import {
  cancelWorkspaceDeletion,
  requestWorkspaceDeletion,
  updateWorkspaceSettings,
  type DeletionState,
  type WorkspaceState,
} from "@/lib/workspace-core";

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

/** Owners only, with the workspace's name typed out; checked in lib/workspace-core.ts. */
export async function requestDeletionAction(
  _previous: DeletionState,
  formData: FormData,
): Promise<DeletionState> {
  const session = await requireTenant();
  const state = await requestWorkspaceDeletion(
    { db: await getSafeDb(), ip: await clientIp() },
    session,
    formData.get("confirm"),
  );
  // Every page shows the pending deletion.
  if (state.status === "ok") revalidatePath("/", "layout");
  return state;
}

export async function cancelDeletionAction(): Promise<DeletionState> {
  const session = await requireTenant();
  const state = await cancelWorkspaceDeletion(
    { db: await getSafeDb(), ip: await clientIp() },
    session,
  );
  if (state.status === "ok") revalidatePath("/", "layout");
  return state;
}
