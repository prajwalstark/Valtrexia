import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AcknowledgeButton } from "@/components/clients/acknowledge-button";
import { ClientDetailView } from "@/components/clients/client-detail-view";
import { acknowledgeIncidentAction } from "@/lib/actions/incidents";
import { requireTenant } from "@/lib/auth";
import { getClientDetail } from "@/lib/dashboard-core";
import { getSafeDb } from "@/lib/db";
import { syncIntervalMinutes } from "@/lib/sync-config";

export const metadata: Metadata = { title: "Client" };

export default async function ClientPage({ params }: { params: Promise<{ clientId: string }> }) {
  const session = await requireTenant();
  const { clientId } = await params;
  const now = new Date();
  // Another tenant's client, or a made-up id, is simply not found.
  const deps = { db: await getSafeDb(), syncIntervalMinutes: syncIntervalMinutes() };
  const client = await getClientDetail(deps, session, clientId, now);
  if (!client) notFound();

  return (
    <ClientDetailView
      client={client}
      now={now}
      acknowledgeSlot={(incident) => (
        <AcknowledgeButton action={acknowledgeIncidentAction.bind(null, client.id, incident.id)} />
      )}
    />
  );
}
