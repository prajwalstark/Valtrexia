import { ChevronDown, ChevronLeft, ClockAlert } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { HealthBadge, STATUS_META, StatusBadge } from "@/components/status/status";
import {
  HISTORY_DAYS,
  type ClientAsset,
  type ClientDetail,
  type OpenIncident,
} from "@/lib/dashboard-core";
import { describeClient } from "@/lib/describe";
import { count, elapsed, formatDate, formatDateTime, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { DayStrip, DayStripLegend } from "./day-strip";

const INCIDENT_LABEL: Record<OpenIncident["type"], string> = {
  failed: "Backup failed",
  missed: "Backup missed",
  stale: "SLA breached",
};

export function ClientDetailView({
  client,
  now,
  acknowledgeSlot,
}: {
  client: ClientDetail;
  now: Date;
  /** Renders the acknowledge control for an incident. A slot keeps this a server component. */
  acknowledgeSlot: (incident: OpenIncident) => ReactNode;
}) {
  const watched = client.assets.filter((asset) => asset.watched);
  const unwatched = client.assets.filter((asset) => !asset.watched);

  return (
    <>
      <Link
        href="/dashboard"
        className="inline-flex items-center gap-1 rounded-md text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft aria-hidden="true" className="size-4" />
        Dashboard
      </Link>
      <div className="mt-4">
        <PageHeader title={client.name} />
        <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
          <HealthBadge health={client.summary.health} />
          <span className="text-muted-foreground">{describeClient(client.summary)}</span>
        </p>
      </div>

      {client.openIncidents.length > 0 ? (
        <section className="mt-10 max-w-4xl" aria-labelledby="incidents-heading">
          <h2 id="incidents-heading" className="text-lg font-semibold">
            Open incidents
          </h2>
          <ul className="mt-4 divide-y divide-line border-y border-line">
            {client.openIncidents.map((incident) => {
              const meta =
                incident.type === "stale"
                  ? { icon: ClockAlert, tone: "text-status-critical" }
                  : STATUS_META[incident.type];
              const Icon = meta.icon;
              return (
                <li
                  key={incident.id}
                  className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3"
                >
                  <p className="flex items-center gap-2">
                    <Icon aria-hidden="true" className={cn("size-4 shrink-0", meta.tone)} />
                    <span>
                      <span className="font-medium">{INCIDENT_LABEL[incident.type]}</span> on{" "}
                      {incident.assetName}
                      <span className="text-subtle-foreground">
                        , open since {timeAgo(incident.openedAt, now)}
                      </span>
                    </span>
                  </p>
                  {incident.acknowledgedAt ? (
                    <p className="text-sm text-muted-foreground">
                      Acknowledged by {incident.acknowledgedBy ?? "a team member"}{" "}
                      {timeAgo(incident.acknowledgedAt, now)}
                    </p>
                  ) : (
                    acknowledgeSlot(incident)
                  )}
                </li>
              );
            })}
          </ul>
          <p className="mt-3 text-sm text-subtle-foreground">
            An incident closes by itself when a backup completes. Acknowledging it only records that
            someone is looking.
          </p>
        </section>
      ) : null}

      <section className="mt-10" aria-labelledby="assets-heading">
        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
          <div>
            <h2 id="assets-heading" className="text-lg font-semibold">
              Assets
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Worst first. Each square is one day of the last {HISTORY_DAYS}, in UTC, showing that
              day’s worst result. Open an asset for its individual backups.
            </p>
          </div>
          <DayStripLegend />
        </div>

        {client.assets.length === 0 ? (
          <p className="mt-6 border-l-2 border-iris-dim pl-4 text-muted-foreground">
            No protected assets have been found for this client yet.
          </p>
        ) : (
          <ul className="mt-5 divide-y divide-line border-y border-line">
            {watched.map((asset) => (
              <AssetRow key={asset.id} asset={asset} now={now} />
            ))}
            {unwatched.map((asset) => (
              <AssetRow key={asset.id} asset={asset} now={now} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function notWatchedReason(asset: ClientAsset): string | null {
  if (asset.isArchived) return "Archived";
  if (asset.isPaused) return "Paused";
  if (!asset.watched && asset.mutedUntil) return `Muted until ${formatDate(asset.mutedUntil)}`;
  return null;
}

function AssetRow({ asset, now }: { asset: ClientAsset; now: Date }) {
  const reason = notWatchedReason(asset);
  const meta = [asset.type, asset.deviceName, asset.integrationName].filter(Boolean).join(", ");

  return (
    <li>
      <details className="group">
        <summary
          className={cn(
            "grid cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto] items-center gap-x-5 gap-y-2 py-3.5 hover:bg-surface sm:px-3 lg:grid-cols-[7.5rem_minmax(0,1fr)_11rem_auto_auto] [&::-webkit-details-marker]:hidden",
            !asset.watched && "opacity-60",
          )}
        >
          <div className="col-start-1 row-start-1">
            <StatusBadge status={asset.currentStatus} />
          </div>

          <div className="col-span-2 col-start-1 row-start-2 min-w-0 lg:col-span-1 lg:col-start-2 lg:row-start-1">
            <p className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-semibold">{asset.name}</span>
              {reason ? (
                <span className="rounded-sm border border-line-strong px-1.5 text-xs text-muted-foreground">
                  {reason}
                </span>
              ) : null}
            </p>
            <p className="mt-0.5 truncate text-sm text-subtle-foreground">{meta}</p>
          </div>

          <p className="col-start-1 row-start-3 text-sm text-muted-foreground lg:col-start-3 lg:row-start-1">
            {asset.lastSuccessAt
              ? `Last backup ${timeAgo(asset.lastSuccessAt, now)}`
              : "Never backed up"}
            {asset.staleSince ? (
              <span className="flex items-start gap-1 text-foreground">
                <ClockAlert
                  aria-hidden="true"
                  className="mt-[3px] size-3.5 shrink-0 text-status-critical"
                />
                {elapsed(asset.staleSince, now)} past its {asset.slaHours}-hour SLA
              </span>
            ) : null}
            {asset.unconfirmedSince ? (
              <span className="block text-subtle-foreground">
                No vendor data since {formatDateTime(asset.unconfirmedSince)}
              </span>
            ) : null}
            {asset.currentStatus === "missed" && asset.lastResultStatus ? (
              <span className="block text-subtle-foreground">
                Last result: {STATUS_META[asset.lastResultStatus].label.toLowerCase()}
              </span>
            ) : null}
          </p>

          <div className="col-span-2 col-start-1 row-start-4 lg:col-span-1 lg:col-start-4 lg:row-start-1">
            <DayStrip days={asset.days} assetName={asset.name} />
          </div>

          <ChevronDown
            aria-hidden="true"
            className="col-start-2 row-start-1 size-4 text-subtle-foreground group-open:rotate-180 lg:col-start-5"
          />
        </summary>

        <div className="pb-5 sm:px-3">
          {asset.results.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No backups in the last {HISTORY_DAYS} days. Expected every{" "}
              {count(asset.expectedFrequencyHours, "hour")}.
            </p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[36rem] text-left text-sm">
                  <caption className="sr-only">
                    Backups of {asset.name} in the last {HISTORY_DAYS} days, newest first
                  </caption>
                  <thead className="text-subtle-foreground">
                    <tr>
                      <th scope="col" className="py-1.5 pr-4 font-normal">
                        Started
                      </th>
                      <th scope="col" className="py-1.5 pr-4 font-normal">
                        Status
                      </th>
                      <th scope="col" className="py-1.5 pr-4 font-normal">
                        Vendor status
                      </th>
                      <th scope="col" className="py-1.5 pr-4 font-normal">
                        Screenshot
                      </th>
                      <th scope="col" className="py-1.5 font-normal">
                        Detail
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line/60">
                    {asset.results.map((result) => (
                      <tr key={result.id}>
                        <td className="py-1.5 pr-4 whitespace-nowrap tabular-nums">
                          {formatDateTime(result.startedAt)}
                        </td>
                        <td className="py-1.5 pr-4">
                          <StatusBadge status={result.status} />
                        </td>
                        <td className="py-1.5 pr-4 text-muted-foreground">
                          {result.vendorStatusRaw}
                        </td>
                        <td className="py-1.5 pr-4 text-muted-foreground">
                          {result.screenshotVerified === null
                            ? "Not attempted"
                            : result.screenshotVerified
                              ? "Verified"
                              : "Failed"}
                        </td>
                        <td className="py-1.5 text-muted-foreground">{result.message ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {asset.resultCount > asset.results.length ? (
                <p className="mt-3 text-sm text-subtle-foreground">
                  Showing the latest {asset.results.length} of {asset.resultCount} backups in this
                  period.
                </p>
              ) : null}
            </>
          )}
        </div>
      </details>
    </li>
  );
}
