import type { Metadata } from "next";
import { WorkspaceSettingsForm } from "@/components/settings/workspace-settings-form";
import {
  timeZoneOption,
  WorkspaceSettingsView,
} from "@/components/settings/workspace-settings-view";
import { DELETION_HOLD_DAYS } from "@valtrexia/core";
import { CancelDeletionForm, RequestDeletionForm } from "@/components/settings/workspace-deletion";
import {
  cancelDeletionAction,
  requestDeletionAction,
  updateWorkspaceAction,
} from "@/lib/actions/workspace";
import { requireTenant } from "@/lib/auth";
import { listTimeZones, timeZoneLabel } from "@/lib/format";
import { getWorkspace } from "@/lib/workspace";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const session = await requireTenant();
  const settings = await getWorkspace();
  const now = new Date();
  // The saved zone is always offered, even if this runtime lists it under another spelling.
  const names = listTimeZones().includes(settings.timeZone)
    ? listTimeZones()
    : [settings.timeZone, ...listTimeZones()];

  return (
    <WorkspaceSettingsView
      settings={settings}
      canManage={session.role === "owner"}
      now={now}
      formSlot={
        <WorkspaceSettingsForm
          action={updateWorkspaceAction}
          timeZone={settings.timeZone}
          graceHours={settings.graceHours}
          zones={names.map((zone) => timeZoneOption(zone, timeZoneLabel(zone, now)))}
        />
      }
      deletionSlot={
        settings.deletion ? (
          <CancelDeletionForm action={cancelDeletionAction} />
        ) : (
          <RequestDeletionForm
            workspaceName={settings.name}
            holdDays={DELETION_HOLD_DAYS}
            action={requestDeletionAction}
          />
        )
      }
    />
  );
}
