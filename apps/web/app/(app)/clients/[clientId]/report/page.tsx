import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ClientReportView } from "@/components/reports/client-report-view";
import { requireTenant } from "@/lib/auth";
import { getSafeDb } from "@/lib/db";
import { getClientReport } from "@/lib/report-core";

export const metadata: Metadata = { title: "Monthly report" };

export default async function ClientReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<{ month?: string | string[] }>;
}) {
  const session = await requireTenant();
  const { clientId } = await params;
  const { month } = await searchParams;
  const now = new Date();
  const page = await getClientReport(
    { db: await getSafeDb() },
    session,
    clientId,
    typeof month === "string" ? month : undefined,
    now,
  );
  if (!page) notFound();
  return <ClientReportView page={page} now={now} />;
}
