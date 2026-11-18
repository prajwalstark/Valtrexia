// Liveness: the process is up and answering. Checks nothing else, so a
// database outage never makes the platform restart healthy web servers.
// Outside the proxy (see proxy.ts): no session, no Clerk.
export const dynamic = "force-dynamic";

export function GET(): Response {
  return new Response("ok\n", {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
