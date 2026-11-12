import { brand, realVendors, SYNC_INTERVAL_MINUTES } from "@valtrexia/core";
import type { Metadata } from "next";
import { PageHeader } from "@/components/shell/page-header";

export const metadata: Metadata = { title: "Integrations" };

export default function IntegrationsPage() {
  return (
    <>
      <PageHeader
        title="Integrations"
        description={`${brand.name} reads backup results from your vendors every ${SYNC_INTERVAL_MINUTES} minutes. Access is read-only: backup jobs are never started, stopped or changed.`}
      />

      <ul className="mt-10 max-w-3xl divide-y divide-line border-y border-line">
        {realVendors.map((vendor) => {
          const available = vendor.availability === "available";
          return (
            <li
              key={vendor.id}
              className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-5"
            >
              <div>
                <h2 className="font-semibold">{vendor.name}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{vendor.summary}</p>
              </div>
              {/* The "Connect" action replaces this text when the credentials form is built. */}
              <p
                className={available ? "text-sm text-foreground" : "text-sm text-subtle-foreground"}
              >
                {available ? "Not connected" : "Planned"}
              </p>
            </li>
          );
        })}
      </ul>
    </>
  );
}
