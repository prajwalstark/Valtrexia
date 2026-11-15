import type { Metadata } from "next";
import { cookies } from "next/headers";
import { DashboardView } from "@/components/dashboard/dashboard-view";
import { getFleet } from "@/lib/fleet";
import { CAPABLE_COOKIE, initialFleetView, PREFERENCE_COOKIE } from "@/lib/fleet-view";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  // getFleet() calls requireTenant(): signed in, second factor, workspace.
  const { overview, now } = await getFleet();

  // Render the same fleet view the browser showed last time, so the page
  // does not jump when the client-side check agrees.
  const jar = await cookies();
  const fleetViewMode = initialFleetView({
    preference: jar.get(PREFERENCE_COOKIE)?.value,
    capable: jar.get(CAPABLE_COOKIE)?.value,
  });

  return <DashboardView overview={overview} now={now} fleetViewMode={fleetViewMode} />;
}
