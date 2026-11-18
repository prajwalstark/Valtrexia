import { getSafeDb } from "@/lib/db";
import { checkReadiness } from "@/lib/readiness";
import { redisPing } from "@/lib/server-deps";

// Readiness: send traffic here only if the database and Redis answer. The
// body says which part failed by name only ("database", "redis"), never why.
// Outside the proxy (see proxy.ts): no session, no Clerk.
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  let redis: (() => Promise<void>) | undefined;
  try {
    redis = redisPing();
  } catch {
    // Misconfigured (no REDIS_URL in production, or not TLS): not ready.
    redis = () => Promise.reject(new Error("not configured"));
  }
  const result = await checkReadiness({
    database: async () => {
      await (await getSafeDb()).ping();
    },
    ...(redis ? { redis } : {}),
  });
  return new Response(result.ready ? "ready\n" : `not ready: ${result.failed.join(", ")}\n`, {
    status: result.ready ? 200 : 503,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
