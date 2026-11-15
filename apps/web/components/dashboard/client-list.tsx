import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { SegmentedBar } from "@/components/status/segmented-bar";
import { HealthBadge, STATUS_META } from "@/components/status/status";
import type { FleetClient } from "@/lib/dashboard-core";
import { describeClient, STATUS_ORDER } from "@/lib/describe";
import { count } from "@/lib/format";

/** Every client, worst first. Each row opens the client. */
export function ClientList({ clients }: { clients: FleetClient[] }) {
  return (
    <ul className="divide-y divide-line border-y border-line">
      {clients.map((client) => (
        <li key={client.id}>
          <Link
            href={`/clients/${client.id}`}
            className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 py-4 hover:bg-surface sm:px-3 md:grid-cols-[9.5rem_minmax(0,1fr)_9rem_7rem_auto]"
          >
            <HealthBadge health={client.summary.health} className="col-start-1 row-start-1" />

            <div className="col-span-2 col-start-1 row-start-2 min-w-0 md:col-span-1 md:col-start-2 md:row-start-1">
              <p className="truncate font-semibold">{client.name}</p>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {describeClient(client.summary)}
              </p>
            </div>

            <SegmentedBar
              dense
              label={`${client.name}, assets by status`}
              segments={STATUS_ORDER.map((status) => ({
                key: status,
                label: STATUS_META[status].label,
                value: client.summary.counts[status],
                fill: STATUS_META[status].fill,
              }))}
              className="col-span-2 col-start-1 row-start-3 md:col-span-1 md:col-start-3 md:row-start-1"
            />

            <p className="col-start-1 row-start-4 text-sm text-subtle-foreground md:col-start-4 md:row-start-1 md:text-right">
              {client.openIncidents > 0 ? count(client.openIncidents, "open incident") : ""}
            </p>

            <ChevronRight
              aria-hidden="true"
              className="col-start-2 row-start-1 size-4 text-subtle-foreground group-hover:text-foreground md:col-start-5"
            />
          </Link>
        </li>
      ))}
    </ul>
  );
}
