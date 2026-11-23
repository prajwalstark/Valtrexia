import type { ReactNode } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Notice } from "@/components/ui/notice";
import { count, formatDateTime } from "@/lib/format";
import type { NotificationsPage } from "@/lib/notifications-core";
import { cn } from "@/lib/utils";

type Channel = NotificationsPage["channels"][number];
type Recent = Channel["recent"][number];

const TYPE_LABEL: Record<string, string> = {
  failed: "failed",
  missed: "missed",
  stale: "past SLA",
};
const KIND_LABEL: Record<Recent["kind"], string> = {
  incidents: "Incidents",
  integration: "Integration",
  test: "Test",
  report: "Monthly summary",
};

function destinationOf(channel: Channel): string {
  const config = (channel.config ?? {}) as { host?: unknown; recipients?: unknown };
  if (channel.type === "webhook") {
    return typeof config.host === "string" ? `Sends to ${config.host}` : "Webhook";
  }
  const recipients = Array.isArray(config.recipients) ? config.recipients.map(String) : [];
  return recipients.length > 0 ? `Emails ${recipients.join(", ")}` : "Email";
}

function hearsAbout(channel: Channel): string {
  const types = channel.incidentTypes.map((type) => TYPE_LABEL[type] ?? type).join(", ");
  const events = [
    channel.notifyOpened ? "when they start" : null,
    channel.notifyClosed ? "when resolved" : null,
  ].filter(Boolean);
  const parts = [
    events.length > 0 ? `${types} backups, ${events.join(" and ")}` : null,
    channel.notifyIntegrationHealth ? "integrations that fail or recover" : null,
    channel.notifyMonthlyReport ? "the monthly summary" : null,
  ].filter(Boolean);
  return parts.length > 0 ? `Hears about ${parts.join("; ")}.` : "Hears about nothing.";
}

function describeRecent(recent: Recent, timeZone: string): { tone: string; text: string } {
  const at = formatDateTime(recent.createdAt, timeZone);
  if (recent.status === "sent") {
    return {
      tone: "text-status-success",
      text: `Sent ${recent.sentAt ? formatDateTime(recent.sentAt, timeZone) : at}`,
    };
  }
  if (recent.status === "failed") {
    return {
      tone: "text-status-critical",
      text: `Not delivered after ${count(recent.attempts, "attempt")}. ${recent.lastError ?? ""}`.trim(),
    };
  }
  if (recent.attempts === 0)
    return { tone: "text-status-unknown", text: `Waiting to be sent, queued ${at}` };
  return {
    tone: "text-status-warning",
    text: `Retrying at ${formatDateTime(recent.nextAttemptAt, timeZone)} (${count(recent.attempts, "attempt")} so far). ${recent.lastError ?? ""}`.trim(),
  };
}

/**
 * Where notifications go. Everyone sees the channels and how their recent
 * messages fared; owners add, test, switch off and delete them.
 */
export function NotificationsView({
  page,
  canManage,
  addSlot,
  controlsSlot,
}: {
  page: NotificationsPage;
  canManage: boolean;
  addSlot: ReactNode;
  controlsSlot: (channel: Channel) => ReactNode;
}) {
  return (
    <>
      <PageHeader
        title="Notifications"
        description="Where news of failed, missed and overdue backups is sent. One message per check, not one per asset, and never the same news twice."
      />

      <section className="mt-10" aria-labelledby="channels-heading">
        <h2 id="channels-heading" className="text-lg font-semibold">
          Channels
        </h2>
        {page.channels.length === 0 ? (
          <p className="mt-4 border-l-2 border-iris-dim pl-4 text-muted-foreground">
            No channels yet. Until one is added, problems are shown here in the app only.
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-line border-y border-line">
            {page.channels.map((channel) => (
              <li key={channel.id} className="py-5 sm:px-3">
                <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-semibold">{channel.name}</span>
                      <span className="rounded-sm border border-line-strong px-1.5 text-xs text-muted-foreground">
                        {channel.type === "webhook" ? "Webhook" : "Email"}
                      </span>
                      {channel.enabled ? null : (
                        <span className="rounded-sm border border-status-warning/60 px-1.5 text-xs text-status-warning">
                          Off
                        </span>
                      )}
                    </p>
                    <p className="mt-1 text-sm break-words text-muted-foreground">
                      {destinationOf(channel)}
                    </p>
                    <p className="mt-0.5 text-sm text-subtle-foreground">{hearsAbout(channel)}</p>
                  </div>
                  {canManage ? <div>{controlsSlot(channel)}</div> : null}
                </div>
                <div className="mt-4">
                  <h3 className="text-xs font-medium tracking-wide text-subtle-foreground uppercase">
                    Recent messages
                  </h3>
                  {channel.recent.length === 0 ? (
                    <p className="mt-1.5 text-sm text-muted-foreground">Nothing sent yet.</p>
                  ) : (
                    <ul className="mt-1.5 space-y-1 text-sm">
                      {channel.recent.map((recent) => {
                        const { tone, text } = describeRecent(recent, page.timeZone);
                        return (
                          <li key={recent.id} className="flex gap-2">
                            <span
                              aria-hidden="true"
                              className={cn("mt-1.5 size-2 shrink-0 rounded-full bg-current", tone)}
                            />
                            <span>
                              <span className="font-medium">{KIND_LABEL[recent.kind]}</span>
                              <span className="text-muted-foreground"> · {text}</span>
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-12" aria-labelledby="add-heading">
        <h2 id="add-heading" className="text-lg font-semibold">
          Add a channel
        </h2>
        <div className="mt-4">
          {canManage ? (
            addSlot
          ) : (
            <Notice kind="info" className="max-w-xl">
              Only workspace owners can add or change notification channels.
            </Notice>
          )}
        </div>
      </section>
    </>
  );
}
