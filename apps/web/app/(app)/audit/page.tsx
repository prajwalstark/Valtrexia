import type { Metadata } from "next";
import { AuditView } from "@/components/audit/audit-view";
import { listAuditLog, parseAuditFilter } from "@/lib/audit-core";
import { requireTenant } from "@/lib/auth";
import { getSafeDb } from "@/lib/db";

export const metadata: Metadata = { title: "Audit log" };

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireTenant();
  // Owners only. The check is made where the log is read, in lib/audit-core.ts.
  const list = await listAuditLog(
    { db: await getSafeDb() },
    session,
    parseAuditFilter(await searchParams),
  );
  return <AuditView list={list} />;
}
