"use server";

import { revalidatePath } from "next/cache";
import { requireTenant } from "@/lib/auth";
import { acknowledgeIncident } from "@/lib/dashboard-core";
import { getSafeDb } from "@/lib/db";
import type { ActionState } from "@/lib/integrations-core";
import { clientIp } from "@/lib/request";

/** Owners and technicians can both acknowledge. The tenant comes from the session. */
export async function acknowledgeIncidentAction(
  clientId: string,
  incidentId: string,
): Promise<ActionState> {
  const session = await requireTenant();
  const state = await acknowledgeIncident(
    { db: await getSafeDb(), ip: await clientIp() },
    session,
    incidentId,
  );
  // `clientId` only chooses which page to refresh. It grants nothing.
  if (state.status === "ok" && /^[0-9a-f-]{36}$/i.test(clientId)) {
    revalidatePath(`/clients/${clientId}`);
  }
  return state;
}
