import Link from "next/link";
import { FleetGrid } from "@/components/fleet/fleet-grid";
import { FleetView } from "@/components/fleet/fleet-view";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import type { FleetOverview } from "@/lib/dashboard-core";
import type { FleetViewMode } from "@/lib/fleet-view";
import { count } from "@/lib/format";
import { ClientList } from "./client-list";
import { FleetSummary } from "./fleet-summary";

export function DashboardView({
  overview,
  fleetViewMode,
}: {
  overview: FleetOverview;
  /** Which fleet view to render first, from the visitor's cookies. */
  fleetViewMode: FleetViewMode;
}) {
  const { integrations, clients } = overview;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Every client, ranked by backup health with the worst first."
      />

      {integrations.failing > 0 ? (
        <Notice kind="error" className="mt-8 max-w-3xl">
          {count(integrations.failing, "integration")} failing to sync. Backup data for the affected
          clients may be out of date.{" "}
          <Link href="/integrations" className="underline underline-offset-4">
            Check integrations
          </Link>
        </Notice>
      ) : null}

      {clients.length === 0 ? (
        <section className="mt-10 max-w-xl border-l-2 border-iris-dim pl-6">
          {integrations.total === 0 ? (
            <>
              <h2 className="text-lg font-semibold">No clients in sight yet</h2>
              <p className="mt-2 leading-relaxed text-muted-foreground">
                Connect a backup vendor and your clients appear here after the first check. Failed
                and missed backups rise to the top.
              </p>
              <Button asChild className="mt-6">
                <Link href="/integrations">Connect a vendor</Link>
              </Button>
            </>
          ) : (
            <>
              <h2 className="text-lg font-semibold">Waiting for the first sync</h2>
              <p className="mt-2 leading-relaxed text-muted-foreground">
                A vendor is connected. Clients appear here once its first sync finishes, usually
                within a few minutes.
              </p>
              <Button asChild variant="outline" className="mt-6">
                <Link href="/integrations">View integrations</Link>
              </Button>
            </>
          )}
        </section>
      ) : (
        <>
          <div className="mt-10">
            <FleetView
              clients={clients}
              initialMode={fleetViewMode}
              grid={<FleetGrid clients={clients} />}
              summary={<FleetSummary overview={overview} />}
            />
          </div>
          <section className="mt-12" aria-labelledby="clients-heading">
            <h2 id="clients-heading" className="mb-4 text-lg font-semibold">
              Clients
            </h2>
            <ClientList clients={clients} />
          </section>
        </>
      )}
    </>
  );
}
