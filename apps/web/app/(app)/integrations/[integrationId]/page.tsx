import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DattoCredentialsForm } from "@/components/integrations/datto-credentials-form";
import { DisconnectForm } from "@/components/integrations/disconnect-form";
import { IntegrationDetailView } from "@/components/integrations/integration-detail-view";
import { TestConnection } from "@/components/integrations/test-connection";
import {
  disconnectAction,
  replaceDattoAction,
  testNewDattoAction,
  testSavedAction,
} from "@/lib/actions/integrations";
import { requireTenant } from "@/lib/auth";
import { getSafeDb } from "@/lib/db";
import { getIntegrationFor } from "@/lib/integrations-core";

export const metadata: Metadata = { title: "Integration" };

export default async function IntegrationPage({
  params,
  searchParams,
}: {
  params: Promise<{ integrationId: string }>;
  searchParams: Promise<{ connected?: string }>;
}) {
  const session = await requireTenant();
  const { integrationId } = await params;
  // Another tenant's integration, or a made-up id, is simply not found.
  const integration = await getIntegrationFor({ db: await getSafeDb() }, session, integrationId);
  if (!integration) notFound();

  const { connected } = await searchParams;
  const isDatto = integration.vendor === "datto_bcdr";

  return (
    <IntegrationDetailView
      integration={integration}
      canManage={session.role === "owner"}
      now={new Date()}
      justConnected={connected === "1"}
      testSlot={<TestConnection action={testSavedAction.bind(null, integration.id)} />}
      replaceSlot={
        isDatto ? (
          <DattoCredentialsForm
            mode="replace"
            saveAction={replaceDattoAction.bind(null, integration.id)}
            testAction={testNewDattoAction}
            cancelHref="/integrations"
          />
        ) : undefined
      }
      disconnectSlot={
        <DisconnectForm
          integrationName={integration.name}
          action={disconnectAction.bind(null, integration.id)}
        />
      }
    />
  );
}
