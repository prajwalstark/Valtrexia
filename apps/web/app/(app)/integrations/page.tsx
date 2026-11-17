import type { Metadata } from "next";
import { IntegrationsView } from "@/components/integrations/integrations-view";
import { requireTenant } from "@/lib/auth";
import { getSafeDb } from "@/lib/db";
import { listIntegrationsFor } from "@/lib/integrations-core";
import { syncIntervalMinutes } from "@/lib/sync-config";
import { getWorkspace } from "@/lib/workspace";

export const metadata: Metadata = { title: "Integrations" };

export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<{ disconnected?: string }>;
}) {
  const session = await requireTenant();
  const integrations = await listIntegrationsFor({ db: await getSafeDb() }, session);
  const { disconnected } = await searchParams;
  const { timeZone } = await getWorkspace();

  return (
    <IntegrationsView
      integrations={integrations}
      canManage={session.role === "owner"}
      now={new Date()}
      syncIntervalMinutes={syncIntervalMinutes()}
      timeZone={timeZone}
      disconnected={disconnected === "1"}
    />
  );
}
