import type { Metadata } from "next";
import { AcknowledgeButton } from "@/components/clients/acknowledge-button";
import { IncidentsView } from "@/components/incidents/incidents-view";
import { acknowledgeIncidentAction } from "@/lib/actions/incidents";
import { requireTenant } from "@/lib/auth";
import { getSafeDb } from "@/lib/db";
import { listIncidents, parseIncidentFilter } from "@/lib/incidents-core";

export const metadata: Metadata = { title: "Incidents" };

export default async function IncidentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireTenant();
  const filter = parseIncidentFilter(await searchParams);
  const list = await listIncidents({ db: await getSafeDb() }, session, filter);

  return (
    <IncidentsView
      list={list}
      now={new Date()}
      acknowledgeSlot={(incident) => (
        <AcknowledgeButton
          action={acknowledgeIncidentAction.bind(null, incident.clientId, incident.id)}
        />
      )}
    />
  );
}
