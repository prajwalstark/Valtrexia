import type { ReactNode } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Notice } from "@/components/ui/notice";
import { count, formatDate, formatDateTime } from "@/lib/format";
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
  deletionSlot,
}: {
  settings: WorkspaceSettings;
  canManage: boolean;
  now: Date;
  formSlot: ReactNode;
  /** The form to schedule or cancel deletion; owners only. */
  deletionSlot?: ReactNode;
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

      <section
        className="mt-16 max-w-xl border-t border-line pt-8"
        aria-labelledby="export-heading"
      >
        <h2 id="export-heading" className="text-lg font-semibold">
          Export data
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          One file with everything this workspace holds: members, integrations, clients, assets and
          their settings, backup history, incidents, notification channels and the audit log. Vendor
          keys, webhook addresses and the raw records vendors send are left out. Once an hour.
        </p>
        {canManage ? (
          <a
            href="/settings/export"
            download
            className="mt-5 inline-flex h-9 items-center rounded-md border border-line-strong px-4 text-sm font-medium hover:bg-surface"
          >
            Download export (.json.gz)
          </a>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">Only workspace owners can export.</p>
        )}
      </section>

      <section
        className="mt-16 max-w-xl border-t border-line pt-8"
        aria-labelledby="delete-heading"
      >
        <h2 id="delete-heading" className="text-lg font-semibold">
          Delete workspace
        </h2>
        {settings.deletion ? (
          <Notice kind="error" className="mt-4">
            {settings.deletion.reason === "organization_deleted"
              ? "This workspace’s organization was deleted."
              : "An owner asked for this workspace to be deleted."}{" "}
            Its data will be deleted on{" "}
            {formatDate(settings.deletion.deleteAfter, settings.timeZone)}. Syncing and
            notifications have stopped.
          </Notice>
        ) : null}
        {canManage && deletionSlot ? (
          <div className="mt-5">{deletionSlot}</div>
        ) : !settings.deletion ? (
          <p className="mt-3 text-sm text-muted-foreground">
            Only workspace owners can delete the workspace.
          </p>
        ) : null}
      </section>
    </>
  );
}
