import type { ReactNode } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Notice } from "@/components/ui/notice";
import { count, formatDateTime } from "@/lib/format";
import type { WorkspaceSettings } from "@/lib/workspace-core";

/** A zone as it is offered in the list: "America/New York (GMT-5)". */
export function timeZoneOption(zone: string, label: string): { value: string; label: string } {
  return { value: zone, label: zone === "UTC" ? "UTC" : `${zone.replaceAll("_", " ")} (${label})` };
}

/**
 * Settings that apply to the whole workspace. Owners get the form, passed in
 * as a slot so this stays a server component; technicians see the values.
 */
export function WorkspaceSettingsView({
  settings,
  canManage,
  now,
  formSlot,
}: {
  settings: WorkspaceSettings;
  canManage: boolean;
  now: Date;
  formSlot: ReactNode;
}) {
  return (
    <>
      <PageHeader
        title="Settings"
        description={`How ${settings.name} reads its dates, and when a backup counts as missed.`}
      />

      <p className="mt-6 text-sm text-muted-foreground">
        It is now {formatDateTime(now, settings.timeZone)} in this workspace.
      </p>

      {canManage ? (
        <div className="mt-8">{formSlot}</div>
      ) : (
        <>
          <dl className="mt-8 grid max-w-xl grid-cols-[8rem_minmax(0,1fr)] gap-x-6 gap-y-3 text-sm">
            <dt className="text-subtle-foreground">Time zone</dt>
            <dd>{settings.timeZone.replaceAll("_", " ")}</dd>
            <dt className="text-subtle-foreground">Grace period</dt>
            <dd>{count(settings.graceHours, "hour")}</dd>
          </dl>
          <Notice kind="info" className="mt-8 max-w-xl">
            Only workspace owners can change these settings.
          </Notice>
        </>
      )}
    </>
  );
}
