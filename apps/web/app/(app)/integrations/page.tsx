import type { Metadata } from "next";
import { IntegrationsView } from "@/components/integrations/integrations-view";
import { requireTenant } from "@/lib/auth";
import { getSafeDb } from "@/lib/db";
import { listIntegrationsFor } from "@/lib/integrations-core";

export const metadata: Metadata = { title: "Integrations" };

export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<{ disconnected?: string }>;
}) {
  const session = await requireTenant();
  const integrations = await listIntegrationsFor({ db: await getSafeDb() }, session);
  const { disconnected } = await searchParams;

  return (
    <IntegrationsView
      integrations={integrations}
      canManage={session.role === "owner"}
      now={new Date()}
      disconnected={disconnected === "1"}
    />
  );
}
