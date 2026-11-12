import { getVendor } from "@valtrexia/core";
import type { IntegrationSummary } from "@valtrexia/db";
import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Notice } from "@/components/ui/notice";
import { formatDate } from "@/lib/format";
import { keyHint } from "./integrations-view";
import { SyncStatus } from "./sync-status";

/**
 * One integration: its state, and for owners the three things that can be
 * done to it. The forms are passed in as slots so this stays a plain server
 * component.
 */
export function IntegrationDetailView({
  integration,
  canManage,
  now,
  justConnected = false,
  testSlot,
  replaceSlot,
  disconnectSlot,
}: {
  integration: IntegrationSummary;
  canManage: boolean;
  now: Date;
  justConnected?: boolean;
  testSlot?: ReactNode;
  replaceSlot?: ReactNode;
  disconnectSlot?: ReactNode;
}) {
  const vendor = getVendor(integration.vendor);

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
        <PageHeader title={integration.name} />
      </div>

      {justConnected ? (
        <Notice kind="ok" className="mt-6 max-w-2xl">
          {integration.name} is connected. The first sync starts within a few minutes.
        </Notice>
      ) : null}

      <dl className="mt-8 grid max-w-2xl grid-cols-[8rem_minmax(0,1fr)] gap-x-6 gap-y-3 text-sm">
        <dt className="text-subtle-foreground">Vendor</dt>
        <dd>{vendor.name}</dd>
        <dt className="text-subtle-foreground">Keys</dt>
        <dd>{keyHint(integration.credentialHint) ?? "Stored encrypted"}</dd>
        <dt className="text-subtle-foreground">Connected</dt>
        <dd>{formatDate(integration.createdAt)}</dd>
        <dt className="text-subtle-foreground">Sync</dt>
        <dd>
          <SyncStatus state={integration} now={now} />
        </dd>
      </dl>

      {!canManage ? (
        <Notice kind="info" className="mt-10 max-w-2xl">
          Only workspace owners can test, replace or disconnect an integration.
        </Notice>
      ) : (
        <>
          {testSlot ? (
            <section
              className="mt-12 max-w-2xl border-t border-line pt-8"
              aria-labelledby="test-heading"
            >
              <h2 id="test-heading" className="text-lg font-semibold">
                Test connection
              </h2>
              <p className="mt-2 mb-5 text-sm leading-relaxed text-muted-foreground">
                Checks that {vendor.name} still accepts the saved keys. It reads one record and
                changes nothing.
              </p>
              {testSlot}
            </section>
          ) : null}

          {replaceSlot ? (
            <section
              className="mt-6 max-w-2xl border-t border-line pt-8"
              aria-labelledby="replace-heading"
            >
              <h2 id="replace-heading" className="text-lg font-semibold">
                Replace keys
              </h2>
              <p className="mt-2 mb-6 text-sm leading-relaxed text-muted-foreground">
                Use this after rotating the key pair at {vendor.name}. The saved keys cannot be
                viewed, so enter both again. Backup history is kept.
              </p>
              {replaceSlot}
            </section>
          ) : null}

          {disconnectSlot ? (
            <section
              className="mt-6 max-w-2xl border-t border-line pt-8"
              aria-labelledby="disconnect-heading"
            >
              <h2 id="disconnect-heading" className="text-lg font-semibold">
                Disconnect
              </h2>
              <p className="mt-2 mb-6 text-sm leading-relaxed text-muted-foreground">
                Deletes the saved keys and every asset, backup result and incident that came from
                this integration. Clients are kept. This cannot be undone.
              </p>
              {disconnectSlot}
            </section>
          ) : null}
        </>
      )}
    </>
  );
}
