import Link from "next/link";
import { DayGlyph } from "@/components/clients/day-strip";
import { HEALTH_META } from "@/components/status/status";
import type { FleetClient } from "@/lib/dashboard-core";
import { describeClient, STATUS_ORDER } from "@/lib/describe";
import { MAX_SATELLITES } from "@/lib/fleet-view";
import { cn } from "@/lib/utils";

/** Clients drawn as tiles. The rest are in the ranked list below. */
const MAX_TILES = 48;

/**
 * The fleet in two dimensions: one tile per client, worst first, with one
 * square per asset. It is the fallback for the 3D view, and a complete view
 * in its own right: every tile is a link, so it works with a keyboard and a
 * screen reader, and it needs no JavaScript.
 */
export function FleetGrid({ clients }: { clients: FleetClient[] }) {
  const shown = clients.slice(0, MAX_TILES);

  return (
    <div>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))] gap-2">
        {shown.map((client) => {
          const { icon: Icon, tone, label } = HEALTH_META[client.summary.health];
          const assets = STATUS_ORDER.flatMap((status) =>
            Array.from({ length: client.summary.counts[status] }, () => status),
          );
          const drawn = assets.slice(0, MAX_SATELLITES);
          return (
            <li key={client.id}>
              <Link
                href={`/clients/${client.id}`}
                aria-label={`${client.name}: ${label}. ${describeClient(client.summary)}`}
                className="block h-full rounded-lg border border-line p-3 hover:border-line-strong hover:bg-surface"
              >
                <p className="flex items-center gap-1.5">
                  <Icon aria-hidden="true" className={cn("size-4 shrink-0", tone)} />
                  <span className="truncate text-sm font-medium">{client.name}</span>
                </p>
                <div className="mt-2.5 flex min-h-3.5 flex-wrap gap-0.5" aria-hidden="true">
                  {drawn.map((status, index) => (
                    <DayGlyph key={index} status={status} />
                  ))}
                  {assets.length > drawn.length ? (
                    <span className="ml-1 text-xs text-subtle-foreground">
                      +{assets.length - drawn.length}
                    </span>
                  ) : null}
                  {assets.length === 0 ? (
                    <span className="text-xs text-subtle-foreground">Nothing watched</span>
                  ) : null}
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
      {clients.length > shown.length ? (
        <p className="mt-3 text-sm text-subtle-foreground">
          Showing the {shown.length} clients that most need attention. All {clients.length} are in
          the list below.
        </p>
      ) : null}
    </div>
  );
}
