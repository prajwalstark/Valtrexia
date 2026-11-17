import type { Metadata } from "next";
import { ChannelControls } from "@/components/notifications/channel-controls";
import { AddChannel } from "@/components/notifications/channel-form";
import { NotificationsView } from "@/components/notifications/notifications-view";
import {
  createEmailChannelAction,
  createWebhookChannelAction,
  deleteChannelAction,
  sendTestNotificationAction,
  setChannelEnabledAction,
} from "@/lib/actions/notifications";
import { requireTenant } from "@/lib/auth";
import { getSafeDb } from "@/lib/db";
import { getNotificationsPage } from "@/lib/notifications-core";
import { emailConfigured } from "@/lib/server-deps";

export const metadata: Metadata = { title: "Notifications" };

export default async function NotificationsPage() {
  const session = await requireTenant();
  const page = await getNotificationsPage({ db: await getSafeDb() }, session);

  return (
    <NotificationsView
      page={page}
      canManage={session.role === "owner"}
      addSlot={
        <AddChannel
          webhookAction={createWebhookChannelAction}
          emailAction={createEmailChannelAction}
          emailAvailable={emailConfigured(process.env)}
        />
      }
      controlsSlot={(channel) => (
        <ChannelControls
          name={channel.name}
          enabled={channel.enabled}
          testAction={sendTestNotificationAction.bind(null, channel.id)}
          enableAction={setChannelEnabledAction.bind(null, channel.id, true)}
          disableAction={setChannelEnabledAction.bind(null, channel.id, false)}
          deleteAction={deleteChannelAction.bind(null, channel.id)}
        />
      )}
    />
  );
}
