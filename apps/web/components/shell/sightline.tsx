import { SYNC_INTERVAL_MINUTES } from "@valtrexia/core";
import { CircleAlert, CircleCheck, CircleDashed, ClockAlert } from "lucide-react";
import Link from "next/link";
import { STATUS_META } from "@/components/status/status";
import type { FleetOverview } from "@/lib/dashboard-core";
import { count, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The strip across the top of every page that keeps fleet health in view:
 * how many assets have failed, missed or warned right now, and how fresh the
 * data is. It is the product's tagline made literal.
 */
export function Sightline({ overview, now }: { overview: FleetOverview; now: Date }) {
  const { assets, integrations } = overview;
  // Unknown is listed too: an asset whose backup cannot be confirmed must
  // never be folded into "all backed up".
  const attention = (["failed", "missed", "warning", "unknown"] as const).filter(
    (s) => assets.counts[s] > 0,
  );

  let left;
  if (integrations.total === 0) {
    left = (
      <p className="flex items-center gap-2 text-muted-foreground">
        <CircleDashed aria-hidden="true" className="size-4 text-status-unknown" />
        Nothing in sight yet. Connect a vendor to start watching backups.
      </p>
    );
  } else if (assets.watched === 0) {
    left = (
      <p className="flex items-center gap-2 text-muted-foreground">
        <CircleDashed aria-hidden="true" className="size-4 text-status-unknown" />
        Waiting for the first sync to finish.
      </p>
    );
  } else if (attention.length === 0) {
    left = (
      <p className="flex items-center gap-2">
        <CircleCheck aria-hidden="true" className="size-4 text-status-success" />
        {assets.watched === 1
          ? "The 1 watched asset is"
          : `All ${assets.watched} watched assets are`}{" "}
        backed up
      </p>
    );
  } else {
    left = (
      <ul className="flex flex-wrap items-center gap-x-5 gap-y-1">
        {attention.map((status) => {
          const { icon: Icon, tone, label } = STATUS_META[status];
          return (
            <li key={status} className="inline-flex items-center gap-1.5">
              <Icon aria-hidden="true" className={cn("size-4", tone)} />
              <span className="font-semibold tabular-nums">{assets.counts[status]}</span>
              <span className="text-muted-foreground">
                {status === "warning" && assets.counts[status] !== 1 ? "Warnings" : label}
              </span>
            </li>
          );
        })}
        <li className="text-subtle-foreground">of {count(assets.watched, "asset")}</li>
        {assets.pastSla > 0 ? (
          <li className="inline-flex items-center gap-1.5">
            <ClockAlert aria-hidden="true" className="size-4 text-status-critical" />
            <span className="font-semibold tabular-nums">{assets.pastSla}</span>
            <span className="text-muted-foreground">past SLA</span>
          </li>
        ) : null}
      </ul>
    );
  }

  const right =
    integrations.failing > 0 ? (
      <Link
        href="/integrations"
        className="inline-flex items-center gap-1.5 rounded-md hover:text-foreground"
      >
        <CircleAlert aria-hidden="true" className="size-4 text-status-critical" />
        {count(integrations.failing, "integration")} failing to sync
      </Link>
    ) : integrations.stalled > 0 ? (
      <Link
        href="/integrations"
        className="inline-flex items-center gap-1.5 rounded-md hover:text-foreground"
      >
        <CircleAlert aria-hidden="true" className="size-4 text-status-critical" />
        {integrations.lastSyncAt
          ? `Syncs have stopped. Last data ${timeAgo(integrations.lastSyncAt, now)}`
          : "Syncs are not running"}
      </Link>
    ) : integrations.lastSyncAt ? (
      <span>Last synced {timeAgo(integrations.lastSyncAt, now)}</span>
    ) : (
      <span>Backups are checked every {SYNC_INTERVAL_MINUTES} minutes</span>
    );

  return (
    <div
      role="status"
      aria-label="Fleet status"
      className="flex min-h-12 flex-wrap items-center justify-between gap-x-6 gap-y-1 border-b border-line bg-surface px-4 py-2 text-sm md:px-8"
    >
      {left}
      <p className="text-subtle-foreground">{right}</p>
    </div>
  );
}
