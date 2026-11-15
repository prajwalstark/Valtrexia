import { HEALTH_LEVELS } from "@valtrexia/core";
import { SegmentedBar } from "@/components/status/segmented-bar";
import { HEALTH_META, STATUS_META } from "@/components/status/status";
import type { FleetOverview } from "@/lib/dashboard-core";
import { STATUS_ORDER } from "@/lib/describe";
import { count } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The fleet at a glance: how the clients split by health, and how the assets
 * split by status. Each is a thin bar with its figures written out beside it,
 * so the numbers never depend on reading the bar.
 */
export function FleetSummary({ overview }: { overview: FleetOverview }) {
  const clientParts = HEALTH_LEVELS.map((level) => ({
    key: level,
    label: HEALTH_META[level].label,
    value: overview.health[level],
    fill: HEALTH_META[level].fill,
    meta: HEALTH_META[level],
  }));
  const assetParts = STATUS_ORDER.map((status) => ({
    key: status,
    label: STATUS_META[status].label,
    value: overview.assets.counts[status],
    fill: STATUS_META[status].fill,
    meta: STATUS_META[status],
  }));

  return (
    // A container query, not a viewport one: the summary sits in a narrow
    // column beside the 3D stage and at full width under the 2D grid.
    <section aria-label="Fleet summary" className="@container">
      <div className="grid gap-x-12 gap-y-8 @3xl:grid-cols-2">
        <Split
          heading={count(overview.clients.length, "client")}
          label="Clients by health"
          parts={clientParts}
        />
        <Split
          heading={`${count(overview.assets.watched, "asset")} watched`}
          note={
            overview.assets.excluded > 0
              ? `${overview.assets.excluded} more paused, archived or muted`
              : undefined
          }
          label="Assets by status"
          parts={assetParts}
        />
      </div>
    </section>
  );
}

function Split({
  heading,
  note,
  label,
  parts,
}: {
  heading: string;
  note?: string | undefined;
  label: string;
  parts: {
    key: string;
    label: string;
    value: number;
    fill: string;
    meta: { icon: React.ComponentType<{ className?: string }>; tone: string };
  }[];
}) {
  return (
    <div>
      <p className="flex flex-wrap items-baseline gap-x-3">
        <span className="font-wide text-xl font-semibold tracking-[-0.01em]">{heading}</span>
        {note ? <span className="text-sm text-subtle-foreground">{note}</span> : null}
      </p>
      <SegmentedBar segments={parts} label={label} className="mt-3" />
      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-sm">
        {parts
          .filter((part) => part.value > 0)
          .map(({ key, label: name, value, meta: { icon: Icon, tone } }) => (
            <li key={key} className="inline-flex items-center gap-1.5">
              <Icon aria-hidden="true" className={cn("size-4", tone)} />
              <span className="font-semibold tabular-nums">{value}</span>
              <span className="text-muted-foreground">{name}</span>
            </li>
          ))}
      </ul>
    </div>
  );
}
