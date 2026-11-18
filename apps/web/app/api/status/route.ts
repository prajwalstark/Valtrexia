import { fleetSnapshotKey } from "@valtrexia/core/server";
import { getSafeDb } from "@/lib/db";
import { getRedisForStatus } from "@/lib/server-deps";
import { operatorStatus, readHeartbeats } from "@/lib/status-core";

// The service's health for an external monitor, behind OPERATOR_STATUS_TOKEN.
// Outside the proxy (see proxy.ts): no session, no Clerk. Counts and
// condition names only.
export const dynamic = "force-dynamic";

const HEADERS = { "cache-control": "no-store" };

export async function GET(request: Request): Promise<Response> {
  // Redis and the database are reached only once the token has been checked,
  // so a request without it costs nothing and learns nothing.
  const result = await operatorStatus(request.headers.get("authorization"), {
    token: process.env.OPERATOR_STATUS_TOKEN,
    heartbeats: async () => {
      const redis = getRedisForStatus();
      return redis ? readHeartbeats(redis) : [];
    },
    fleetSnapshot: async () => getRedisForStatus()?.get(fleetSnapshotKey()) ?? null,
    openAlerts: async () => (await getSafeDb()).openOperatorAlerts(),
    now: Date.now(),
    checkSeconds: Number(process.env.OPERATOR_CHECK_SECONDS) || 300,
  }).catch(() => null);

  if (result === null) {
    return Response.json(
      { status: "problem", problems: ["status_unavailable"] },
      { status: 503, headers: HEADERS },
    );
  }
  if (result.kind === "off") return new Response("Not found\n", { status: 404, headers: HEADERS });
  if (result.kind === "unauthorized") {
    return new Response("Unauthorized\n", {
      status: 401,
      headers: { ...HEADERS, "www-authenticate": "Bearer" },
    });
  }
  return Response.json(result.body, { status: result.status, headers: HEADERS });
}
