import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGuardedFetch, OutboundFailedError, type Resolver } from "./outbound";

let server: Server;
let base: string;
let port: string;
const seen: { method: string; url: string; headers: IncomingHttpHeaders }[] = [];
const RELAXED = { allowHttp: true, allowPrivate: true };

beforeAll(async () => {
  server = createServer((request, response) => {
    seen.push({ method: request.method!, url: request.url!, headers: request.headers });
    if (request.url === "/slow") return;
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "https://elsewhere.example/steal" }).end();
    } else if (request.url === "/big") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(Buffer.alloc(3 * 1024 * 1024, "x"));
    } else if (request.url === "/empty") {
      response.writeHead(204).end();
    } else {
      response
        .writeHead(200, { "content-type": "application/json", "x-trace": "abc" })
        .end(JSON.stringify({ data: [1, 2, 3], path: request.url }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = String((server.address() as AddressInfo).port);
  base = `http://127.0.0.1:${port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

describe("createGuardedFetch", () => {
  it("behaves like fetch for a GET: status, headers, JSON body, request headers sent", async () => {
    const guarded = createGuardedFetch({ policy: RELAXED });
    const response = await guarded(`${base}/api/v3/about?x=1`, {
      headers: { authorization: "Bearer test-key", "x-client-version": "3.5.1" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-trace")).toBe("abc");
    expect(await response.json()).toEqual({ data: [1, 2, 3], path: "/api/v3/about?x=1" });
    expect(seen.at(-1)!.headers).toMatchObject({
      authorization: "Bearer test-key",
      "x-client-version": "3.5.1",
    });
  });

  it("refuses anything but GET, before connecting", async () => {
    const before = seen.length;
    const guarded = createGuardedFetch({ policy: RELAXED });
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "post"]) {
      await expect(guarded(`${base}/jobs`, { method })).rejects.toThrow(/Only GET/);
    }
    expect(seen).toHaveLength(before);
  });

  it("returns a redirect instead of following it", async () => {
    const before = seen.length;
    const response = await createGuardedFetch({ policy: RELAXED })(`${base}/redirect`);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://elsewhere.example/steal");
    expect(seen).toHaveLength(before + 1);
  });

  it("handles a response with no body", async () => {
    const response = await createGuardedFetch({ policy: RELAXED })(`${base}/empty`);
    expect(response.status).toBe(204);
  });

  it("fails a response larger than the limit", async () => {
    const guarded = createGuardedFetch({ policy: RELAXED, maxResponseBytes: 1024 * 1024 });
    await expect(guarded(`${base}/big`)).rejects.toBeInstanceOf(OutboundFailedError);
  });

  it("honours the caller's abort signal", async () => {
    const started = Date.now();
    await expect(
      createGuardedFetch({ policy: RELAXED })(`${base}/slow`, { signal: AbortSignal.timeout(150) }),
    ).rejects.toMatchObject({ reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("refuses private destinations under the normal policy, without connecting", async () => {
    const before = seen.length;
    const strict = createGuardedFetch();
    await expect(strict(`${base}/x`)).rejects.toMatchObject({ reason: "not_https" });
    await expect(strict(`https://127.0.0.1:${port}/x`)).rejects.toMatchObject({
      reason: "private_address",
    });
    const rebinding: Resolver = async () => [{ address: "127.0.0.1", family: 4 }];
    const httpOnly = createGuardedFetch({ policy: { allowHttp: true }, resolver: rebinding });
    await expect(httpOnly(`http://vspc.example.com:${port}/x`)).rejects.toMatchObject({
      reason: "private_address",
    });
    expect(seen).toHaveLength(before);
  });

  it("connects to the address that was checked", async () => {
    let lookups = 0;
    const once: Resolver = async () => {
      lookups += 1;
      return [{ address: "127.0.0.1", family: 4 }];
    };
    const response = await createGuardedFetch({ policy: RELAXED, resolver: once })(
      `http://vspc.example.com:${port}/api/v3/about`,
    );
    expect(response.status).toBe(200);
    expect(lookups).toBe(1);
    expect(seen.at(-1)!.headers.host).toBe(`vspc.example.com:${port}`);
  });
});
