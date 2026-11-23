"use server";

import { revalidatePath } from "next/cache";
import { requireTenant } from "@/lib/auth";
import {
  createEmailChannelFor,
  createWebhookChannelFor,
  deleteChannelFor,
  sendTestNotificationFor,
  setChannelEnabledFor,
  type ChannelState,
} from "@/lib/notifications-core";
import { notificationDeps } from "@/lib/server-deps";

// Owners only; the check is made in lib/notifications-core.ts. The tenant
// comes from the session, and a channel id only says which of its channels.

const refresh = (state: ChannelState) => {
  if (state.status === "ok") revalidatePath("/notifications");
  return state;
};

const preferences = (formData: FormData) => ({
  name: formData.get("name"),
  incidentTypes: formData.getAll("incidentTypes"),
  notifyOpened: formData.get("notifyOpened"),
  notifyClosed: formData.get("notifyClosed"),
  notifyIntegrationHealth: formData.get("notifyIntegrationHealth"),
  notifyMonthlyReport: formData.get("notifyMonthlyReport"),
});

export async function createWebhookChannelAction(
  _previous: ChannelState,
  formData: FormData,
): Promise<ChannelState> {
  const session = await requireTenant();
  return refresh(
    await createWebhookChannelFor(await notificationDeps(), session, {
      ...preferences(formData),
      url: formData.get("url"),
    }),
  );
}

export async function createEmailChannelAction(
  _previous: ChannelState,
  formData: FormData,
): Promise<ChannelState> {
  const session = await requireTenant();
  return refresh(
    await createEmailChannelFor(await notificationDeps(), session, {
      ...preferences(formData),
      recipients: formData.get("recipients"),
    }),
  );
}

export async function sendTestNotificationAction(channelId: string): Promise<ChannelState> {
  const session = await requireTenant();
  return refresh(await sendTestNotificationFor(await notificationDeps(), session, channelId));
}

export async function setChannelEnabledAction(
  channelId: string,
  enabled: boolean,
): Promise<ChannelState> {
  const session = await requireTenant();
  return refresh(await setChannelEnabledFor(await notificationDeps(), session, channelId, enabled));
}

export async function deleteChannelAction(channelId: string): Promise<ChannelState> {
  const session = await requireTenant();
  return refresh(await deleteChannelFor(await notificationDeps(), session, channelId));
}
