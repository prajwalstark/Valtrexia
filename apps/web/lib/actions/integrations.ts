"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireTenant } from "@/lib/auth";
import {
  connectDatto,
  disconnectIntegration,
  replaceDattoCredentials,
  testNewDattoCredentials,
  testSavedIntegration,
  type ActionState,
} from "@/lib/integrations-core";
import { integrationDeps } from "@/lib/server-deps";

// Every action starts with requireTenant(): the layout's check does not
// cover server actions, which can be called directly. The owner check is
// made inside each core function.
//
// Nothing here returns credentials. The form's values travel one way.

function dattoFields(formData: FormData) {
  return {
    name: formData.get("name") ?? "",
    publicKey: formData.get("publicKey"),
    secretKey: formData.get("secretKey"),
  };
}

export async function testNewDattoAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireTenant();
  return testNewDattoCredentials(await integrationDeps(), session, dattoFields(formData));
}

export async function connectDattoAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireTenant();
  const state = await connectDatto(await integrationDeps(), session, dattoFields(formData));
  if (state.status === "ok" && state.integrationId) {
    revalidatePath("/integrations");
    redirect(`/integrations/${state.integrationId}?connected=1`);
  }
  return state;
}

export async function testSavedAction(integrationId: string): Promise<ActionState> {
  const session = await requireTenant();
  return testSavedIntegration(await integrationDeps(), session, integrationId);
}

export async function replaceDattoAction(
  integrationId: string,
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireTenant();
  const state = await replaceDattoCredentials(
    await integrationDeps(),
    session,
    integrationId,
    dattoFields(formData),
  );
  if (state.status === "ok") revalidatePath(`/integrations/${integrationId}`);
  return state;
}

export async function disconnectAction(
  integrationId: string,
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireTenant();
  const state = await disconnectIntegration(
    await integrationDeps(),
    session,
    integrationId,
    formData.get("confirm"),
  );
  if (state.status === "ok") {
    revalidatePath("/integrations");
    redirect("/integrations?disconnected=1");
  }
  return state;
}
