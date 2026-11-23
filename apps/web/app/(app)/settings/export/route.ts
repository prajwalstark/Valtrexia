import { requireTenant } from "@/lib/auth";
import { getSafeDb } from "@/lib/db";
import { gzipStream, startWorkspaceExport } from "@/lib/export-core";
import { clientIp } from "@/lib/request";
import { getExportLimiter } from "@/lib/server-deps";

// The workspace's data as a gzipped JSON download. Owners only, one per hour,
// audited; the checks are in lib/export-core.ts. The tenant comes from the session.
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const session = await requireTenant();
  const start = await startWorkspaceExport(
    { db: await getSafeDb(), limiter: getExportLimiter(), ip: await clientIp() },
    session,
  );
  if (start.kind === "refused") {
    return new Response(`${start.message}\n`, {
      status: start.status,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  return new Response(gzipStream(start.chunks), {
    headers: {
      "content-type": "application/gzip",
      "content-disposition": `attachment; filename="${start.filename}"`,
      "cache-control": "no-store",
    },
  });
}
