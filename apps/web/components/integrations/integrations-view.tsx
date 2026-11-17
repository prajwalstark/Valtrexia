import { brand, getVendor, realVendors, type VendorId } from "@valtrexia/core";
import type { IntegrationSummary } from "@valtrexia/db";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { SyncStatus } from "./sync-status";

/**
 * What saved credentials look like on screen: never more than the last four
 * characters of a key, and for a VSPC console, the host it is on.
 */
export function keyHint(vendor: VendorId, hint: string | null): string | null {
  if (!hint) return null;
  return vendor === "datto_bcdr" ? `Public key ending ${hint}` : hint;
}

/** Where to connect each vendor that can be connected. */
const CONNECT_HREF: Partial<Record<VendorId, string>> = {
  datto_bcdr: "/integrations/connect/datto",
  veeam_vspc: "/integrations/connect/vspc",
};

export function IntegrationsView({
  integrations,
  canManage,
  now,
  syncIntervalMinutes,
  timeZone,
  disconnected = false,
}: {
  integrations: IntegrationSummary[];
  /** Owners can connect, test, replace and disconnect. Technicians can look. */
  canManage: boolean;
  now: Date;
  syncIntervalMinutes: number;
  timeZone: string;
  disconnected?: boolean;
}) {
  return (
    <>
      <PageHeader
        title="Integrations"
        description={`${brand.name} reads backup results from your vendors every ${syncIntervalMinutes} minutes. Access is read-only: backup jobs are never started, stopped or changed.`}
      />

      {disconnected ? (
        <Notice kind="ok" className="mt-8 max-w-3xl">
          The integration was disconnected, and its assets and backup history were removed.
        </Notice>
      ) : null}

      {!canManage ? (
        <Notice kind="info" className="mt-8 max-w-3xl">
          Only workspace owners can connect vendors or change their keys.
        </Notice>
      ) : null}

      <section className="mt-10 max-w-3xl" aria-labelledby="connected-heading">
        <h2 id="connected-heading" className="text-lg font-semibold">
          Connected
        </h2>
        {integrations.length === 0 ? (
          <p className="mt-3 border-l-2 border-iris-dim pl-4 leading-relaxed text-muted-foreground">
            No vendors connected yet.{" "}
            {canManage
              ? "Connect one below to start watching backups."
              : "An owner can connect one."}
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-line border-y border-line">
            {integrations.map((integration) => (
              <li key={integration.id}>
                <Link
                  href={`/integrations/${integration.id}`}
                  className="group flex items-center gap-4 py-5 hover:bg-surface sm:px-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{integration.name}</p>
                    <p className="mt-0.5 text-sm text-subtle-foreground">
                      {[
                        getVendor(integration.vendor).name,
                        keyHint(integration.vendor, integration.credentialHint),
                      ]
                        .filter((part) => part && part !== integration.name)
                        .join(", ")}
                    </p>
                    <SyncStatus
                      state={integration}
                      now={now}
                      syncIntervalMinutes={syncIntervalMinutes}
                      timeZone={timeZone}
                      className="mt-2"
                    />
                  </div>
                  <ChevronRight
                    aria-hidden="true"
                    className="size-4 shrink-0 text-subtle-foreground group-hover:text-foreground"
                  />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-12 max-w-3xl" aria-labelledby="vendors-heading">
        <h2 id="vendors-heading" className="text-lg font-semibold">
          Vendors
        </h2>
        <ul className="mt-4 divide-y divide-line border-y border-line">
          {realVendors.map((vendor) => (
            <li
              key={vendor.id}
              className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 py-5"
            >
              <div>
                <h3 className="font-semibold">{vendor.name}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{vendor.summary}</p>
              </div>
              {CONNECT_HREF[vendor.id] && canManage ? (
                <Button asChild variant="outline" size="sm">
                  <Link href={CONNECT_HREF[vendor.id]!}>Connect</Link>
                </Button>
              ) : vendor.availability === "planned" ? (
                <p className="text-sm text-subtle-foreground">Planned</p>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
