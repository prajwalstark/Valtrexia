"use server";

import { revalidatePath } from "next/cache";
import {
  muteAssets,
  unmuteAssets,
  updateBackupExpectations,
  type SettingsState,
} from "@/lib/asset-settings-core";
import { requireTenant } from "@/lib/auth";
import { getSafeDb } from "@/lib/db";
import { clientIp } from "@/lib/request";

// Every action takes the tenant from the session and nothing else. The ids
// passed in only say which of that tenant's assets is meant; who may do what
// is decided in lib/asset-settings-core.ts.

async function settingsDeps() {
  return { db: await getSafeDb(), ip: await clientIp() };
}

/** Refreshes the pages that show the change. The client id comes from the database. */
function refresh(state: SettingsState): SettingsState {
  if (state.status === "ok") {
    revalidatePath(`/clients/${state.clientId}`);
    revalidatePath("/dashboard");
  }
  return state;
}

const muteFields = (formData: FormData) => ({
  duration: formData.get("duration"),
  reason: formData.get("reason"),
});
const expectationFields = (formData: FormData) => ({
  expectedFrequencyHours: formData.get("expectedFrequencyHours"),
  slaHours: formData.get("slaHours"),
});

export async function muteAssetAction(
  assetId: string,
  _previous: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const session = await requireTenant();
  return refresh(
    await muteAssets(await settingsDeps(), session, { assetId }, muteFields(formData)),
  );
}

export async function unmuteAssetAction(assetId: string): Promise<SettingsState> {
  const session = await requireTenant();
  return refresh(await unmuteAssets(await settingsDeps(), session, { assetId }));
}

export async function updateAssetExpectationsAction(
  assetId: string,
  _previous: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const session = await requireTenant();
  return refresh(
    await updateBackupExpectations(
      await settingsDeps(),
      session,
      { assetId },
      expectationFields(formData),
    ),
  );
}

export async function muteClientAssetsAction(
  clientId: string,
  _previous: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const session = await requireTenant();
  return refresh(
    await muteAssets(await settingsDeps(), session, { clientId }, muteFields(formData)),
  );
}

export async function unmuteClientAssetsAction(clientId: string): Promise<SettingsState> {
  const session = await requireTenant();
  return refresh(await unmuteAssets(await settingsDeps(), session, { clientId }));
}

export async function updateClientExpectationsAction(
  clientId: string,
  _previous: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const session = await requireTenant();
  return refresh(
    await updateBackupExpectations(
      await settingsDeps(),
      session,
      { clientId },
      expectationFields(formData),
    ),
  );
}
