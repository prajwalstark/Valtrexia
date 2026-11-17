import { getVendor } from "@valtrexia/core";
import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/shell/page-header";
import { Notice } from "@/components/ui/notice";
import { UniviewCredentialsForm } from "@/components/integrations/uniview-credentials-form";
import { connectUniviewAction, testNewUniviewAction } from "@/lib/actions/integrations";
import { requireTenant } from "@/lib/auth";

const vendor = getVendor("kaseya_uniview");

export const metadata: Metadata = { title: `Connect ${vendor.name}` };

export default async function ConnectUniviewPage() {
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
          description="Enter the client ID and secret of a UniView API client. The connection is tested before anything is saved, and only used to read customers, the assets their appliances protect, and the outcome of each backup."
        />
      </div>

      <div className="mt-10">
        {session.role === "owner" ? (
          <UniviewCredentialsForm
            mode="connect"
            saveAction={connectUniviewAction}
            testAction={testNewUniviewAction}
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
