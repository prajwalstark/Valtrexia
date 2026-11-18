import { getVendor } from "@valtrexia/core";
import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/shell/page-header";
import { Notice } from "@/components/ui/notice";
import { VspcCredentialsForm } from "@/components/integrations/vspc-credentials-form";
import { connectVspcAction, testNewVspcAction } from "@/lib/actions/integrations";
import { requireTenant } from "@/lib/auth";

const vendor = getVendor("veeam_vspc");

export const metadata: Metadata = { title: `Connect ${vendor.name}` };

export default async function ConnectVspcPage() {
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
          description="Enter your console's address and a read-only API key. The connection is tested before anything is saved, and only used to read companies, protected machines and the outcome of their backup jobs."
        />
      </div>

      <div className="mt-10">
        {session.role === "owner" ? (
          <VspcCredentialsForm
            mode="connect"
            saveAction={connectVspcAction}
            testAction={testNewVspcAction}
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
