import type { Metadata } from "next";
import { DashboardView } from "@/components/dashboard/dashboard-view";
import { getFleet } from "@/lib/fleet";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  // getFleet() calls requireTenant(): signed in, second factor, workspace.
  const { overview } = await getFleet();
  return <DashboardView overview={overview} />;
}
