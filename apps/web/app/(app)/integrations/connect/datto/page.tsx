import { getVendor } from "@valtrexia/core";
import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { DattoCredentialsForm } from "@/components/integrations/datto-credentials-form";
import { PageHeader } from "@/components/shell/page-header";
import { Notice } from "@/components/ui/notice";
import { connectDattoAction, testNewDattoAction } from "@/lib/actions/integrations";
import { requireTenant } from "@/lib/auth";

const vendor = getVendor("datto_bcdr");

export const metadata: Metadata = { title: `Connect ${vendor.name}` };

export default async function ConnectDattoPage() {
  const session = await requireTenant();

  return (
    <>
      <Link
        href="/integrations"
        className="inline-flex items-center gap-1 rounded-md text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft aria-hidden="true" className="size-4" />
        Integrations
      </Link>
      <div className="mt-4">
        <PageHeader
          title={`Connect ${vendor.name}`}
          description="Enter a REST API key pair from the Datto Partner Portal. The keys are tested before they are saved, and only used to read devices, assets and backup results."
        />
      </div>

      <div className="mt-10">
        {session.role === "owner" ? (
          <DattoCredentialsForm
            mode="connect"
            saveAction={connectDattoAction}
            testAction={testNewDattoAction}
            cancelHref="/integrations"
          />
        ) : (
          <Notice kind="info" className="max-w-2xl">
            Only workspace owners can connect a vendor.
          </Notice>
        )}
      </div>
    </>
  );
}
