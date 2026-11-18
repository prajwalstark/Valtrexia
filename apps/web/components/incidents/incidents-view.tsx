import Link from "next/link";
import type { ReactNode } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { INCIDENT_META } from "@/components/status/status";
import { Button } from "@/components/ui/button";
import { Pagination, ViewTabs } from "@/components/ui/pagination";
import { count, elapsed, formatDateTime, timeAgo } from "@/lib/format";
import {
  INCIDENT_TYPES,
  incidentQuery,
  type IncidentList,
  type IncidentRow,
  type IncidentView,
} from "@/lib/incidents-core";
import { cn } from "@/lib/utils";

const VIEW_LABEL: Record<IncidentView, string> = {
  attention: "Needs attention",
  acknowledged: "Acknowledged",
  closed: "Closed",
};

const EMPTY: Record<IncidentView, string> = {
  attention:
    "Nothing needs attention. Every open incident has been acknowledged, or there are none.",
  acknowledged: "No open incident is acknowledged at the moment.",
  closed: "No incident has closed yet.",
};

const selectClass =
  "h-9 min-w-0 rounded-md border border-input bg-background px-2.5 text-sm text-foreground";

/**
 * Every incident in the workspace, across clients. Views and filters are
 * plain links and a plain form, so the page works without JavaScript and any
 * view can be bookmarked or shared.
 */
export function IncidentsView({
  list,
  now,
  acknowledgeSlot,
}: {
  list: IncidentList;
  now: Date;
  /** Renders the acknowledge control for an incident. A slot keeps this a server component. */
  acknowledgeSlot: (incident: IncidentRow) => ReactNode;
}) {
  const { filter, rows, counts, clients, timeZone } = list;
  const filtered = filter.clientId !== null || filter.type !== null;

  return (
    <>
      <PageHeader
        title="Incidents"
        description="Every failed, missed and overdue backup across your clients. An incident closes by itself when a backup completes."
      />

      <div className="mt-8">
        <ViewTabs
          label="Incident views"
          tabs={(Object.keys(VIEW_LABEL) as IncidentView[]).map((view) => ({
            href: incidentQuery({ ...filter, view, page: 1 }),
            label: VIEW_LABEL[view],
            count: counts[view],
            current: filter.view === view,
          }))}
        />
      </div>

      <form method="get" action="/incidents" className="mt-5 flex flex-wrap items-end gap-3">
        {filter.view === "attention" ? null : (
          <input type="hidden" name="view" value={filter.view} />
        )}
        <label className="grid gap-1.5 text-sm">
          <span className="text-subtle-foreground">Client</span>
          <select
            name="client"
            defaultValue={filter.clientId ?? ""}
            className={cn(selectClass, "w-56")}
          >
            <option value="">All clients</option>
            {clients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1.5 text-sm">
          <span className="text-subtle-foreground">Type</span>
          <select name="type" defaultValue={filter.type ?? ""} className={cn(selectClass, "w-44")}>
            <option value="">All types</option>
            {INCIDENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {INCIDENT_META[type].label}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="outline" size="sm" className="h-9">
          Apply
        </Button>
        {filtered ? (
          <Link
            href={incidentQuery({ view: filter.view })}
            className="pb-2 text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            Clear filters
          </Link>
        ) : null}
      </form>

      {rows.length === 0 ? (
        <p className="mt-8 border-l-2 border-iris-dim pl-4 text-muted-foreground">
          {filtered ? "No incidents match these filters." : EMPTY[filter.view]}
        </p>
      ) : (
        <>
          <p className="mt-6 text-sm text-subtle-foreground">
            {count(list.total, "incident")}
            {filter.view === "closed" ? ", most recently closed first" : ", oldest first"}
          </p>
          <ul className="mt-3 divide-y divide-line border-y border-line">
            {rows.map((incident) => {
              const meta = INCIDENT_META[incident.type];
              const Icon = meta.icon;
              return (
                <li
                  key={incident.id}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-1.5 py-3 sm:px-3"
                >
                  <div className="min-w-0">
                    <p className="flex items-center gap-2">
                      <Icon aria-hidden="true" className={cn("size-4 shrink-0", meta.tone)} />
                      <span className="min-w-0 truncate">
                        <span className="font-medium">{meta.label}</span> on{" "}
                        <Link
                          href={`/clients/${incident.clientId}`}
                          className="font-medium underline-offset-4 hover:underline"
                        >
                          {incident.assetName}
                        </Link>
                      </span>
                    </p>
                    <p className="mt-0.5 pl-6 text-sm text-subtle-foreground">
                      {incident.clientName}
                      {incident.closedAt ? (
                        <>
                          {" · "}closed {timeAgo(incident.closedAt, now, timeZone)}, after{" "}
                          {elapsed(incident.openedAt, incident.closedAt)}
                        </>
                      ) : (
                        <>
                          {" · "}open for {elapsed(incident.openedAt, now)}, since{" "}
                          {formatDateTime(incident.openedAt, timeZone)}
                        </>
                      )}
                    </p>
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {incident.acknowledgedAt ? (
                      <p>
                        Acknowledged by {incident.acknowledgedBy ?? "a team member"}{" "}
                        {timeAgo(incident.acknowledgedAt, now, timeZone)}
                      </p>
                    ) : incident.closedAt ? (
                      <p>Never acknowledged</p>
                    ) : (
                      acknowledgeSlot(incident)
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <Pagination
            page={filter.page}
            pageCount={list.pageCount}
            href={(page) => incidentQuery({ ...filter, page })}
            className="mt-5"
          />
        </>
      )}
    </>
  );
}
