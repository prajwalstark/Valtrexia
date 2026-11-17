import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  isPublicAddress,
  OutboundFailedError,
  OutboundRefusedError,
  outboundPolicyFromEnv,
  parseOutboundUrl,
  postJson,
  resolvePublicAddresses,
  type Resolver,
} from "./outbound";

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof OutboundRefusedError) return error.reason;
    throw error;
  }
  return "accepted";
};

describe("isPublicAddress", () => {
  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "172.15.255.255", // just below the private range
    "172.32.0.0", // just above it
    "100.63.255.255", // just below carrier-grade NAT
    "2606:4700:4700::1111",
    "2a00:1450:4001:81b::200e",
  ])("accepts %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each([
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["10.0.0.5", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.1.1", "private"],
    ["169.254.169.254", "cloud metadata"],
    ["100.64.0.1", "carrier-grade NAT"],
    ["0.0.0.0", "unspecified"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "broadcast"],
    ["192.0.2.1", "documentation"],
    ["::1", "IPv6 loopback"],
    ["::", "IPv6 unspecified"],
    ["fe80::1", "IPv6 link-local"],
    ["fc00::1", "IPv6 unique local"],
    ["fd12:3456:789a::1", "IPv6 unique local"],
    ["ff02::1", "IPv6 multicast"],
    ["::ffff:127.0.0.1", "IPv4-mapped loopback"],
    ["::ffff:10.0.0.1", "IPv4-mapped private"],
    ["::ffff:8.8.8.8", "IPv4-mapped, even a public one"],
    ["64:ff9b::7f00:1", "NAT64 to loopback"],
    ["2002:7f00:1::", "6to4 to loopback"],
    ["2001:db8::1", "IPv6 documentation"],
  ])("refuses %s (%s)", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it("refuses anything that is not an address", () => {
    for (const value of ["", "localhost", "example.com", "999.1.1.1", "1.2.3", "::g"]) {
      expect(isPublicAddress(value)).toBe(false);
    }
  });
});

describe("parseOutboundUrl", () => {
  it("accepts an ordinary https URL, with a path, a query and an unprivileged port", () => {
    expect(parseOutboundUrl("https://hooks.example.com/in?x=1").hostname).toBe("hooks.example.com");
    expect(parseOutboundUrl("https://vspc.example.com:1280/api").port).toBe("1280");
    expect(parseOutboundUrl("https://example.com:443/").hostname).toBe("example.com");
    expect(parseOutboundUrl("https://8.8.8.8/hook").hostname).toBe("8.8.8.8");
  });

  it.each([
    ["not a url", "malformed"],
    ["", "malformed"],
    ["//example.com/x", "malformed"],
    ["http://example.com/hook", "not_https"],
    ["ftp://example.com/hook", "not_https"],
    ["file:///etc/passwd", "not_https"],
    ["javascript:alert(1)", "not_https"],
    ["https://user:pass@example.com/hook", "has_credentials"],
    ["https://token@example.com/hook", "has_credentials"],
    ["https://example.com:22/", "port_not_allowed"],
    ["https://example.com:80/", "port_not_allowed"],
    ["https://127.0.0.1/hook", "private_address"],
    ["https://10.1.2.3:8443/hook", "private_address"],
    ["https://169.254.169.254/latest/meta-data/", "private_address"],
    ["https://[::1]/hook", "private_address"],
    ["https://[fd00::1]:8443/hook", "private_address"],
    ["https://[::ffff:127.0.0.1]/hook", "private_address"],
  ])("refuses %s as %s", (url, reason) => {
    expect(refusal(() => parseOutboundUrl(url))).toBe(reason);
  });

  it("is not fooled by other spellings of a private address", () => {
    // Decimal, hexadecimal, octal and shortened forms of 127.0.0.1 and 10.0.0.1.
    for (const host of ["2130706433", "0x7f000001", "0177.0.0.1", "127.1", "0x7f.1", "167772161"]) {
      expect(
        refusal(() => parseOutboundUrl(`https://${host}/hook`)),
        host,
      ).toBe("private_address");
    }
  });

  it("writes messages meant for the person who entered the URL", () => {
    expect(() => parseOutboundUrl("http://example.com")).toThrow(
      "The URL must start with https://.",
    );
    expect(() => parseOutboundUrl("https://10.0.0.1")).toThrow(
      "The URL must point to a public address, not a private or internal one.",
    );
  });

  it("allows http and private addresses only when the policy says so", () => {
    const relaxed = { allowHttp: true, allowPrivate: true };
    expect(parseOutboundUrl("http://127.0.0.1:8080/hook", relaxed).port).toBe("8080");
    expect(refusal(() => parseOutboundUrl("http://example.com/", { allowPrivate: true }))).toBe(
      "not_https",
    );
    expect(refusal(() => parseOutboundUrl("https://127.0.0.1/", { allowHttp: true }))).toBe(
      "private_address",
    );
    // Credentials in a URL are refused whatever the policy.
    expect(refusal(() => parseOutboundUrl("http://a:b@127.0.0.1/", relaxed))).toBe(
      "has_credentials",
    );
  });
});

describe("outboundPolicyFromEnv", () => {
  it("is strict unless the switch is on, and always strict in production", () => {
    expect(outboundPolicyFromEnv({})).toEqual({});
    expect(outboundPolicyFromEnv({ VALTREXIA_ALLOW_PRIVATE_DESTINATIONS: "false" })).toEqual({});
    expect(outboundPolicyFromEnv({ VALTREXIA_ALLOW_PRIVATE_DESTINATIONS: "1" })).toEqual({});
    expect(
      outboundPolicyFromEnv({
        VALTREXIA_ALLOW_PRIVATE_DESTINATIONS: "true",
        NODE_ENV: "development",
      }),
    ).toEqual({ allowPrivate: true, allowHttp: true });
    expect(
      outboundPolicyFromEnv({
        VALTREXIA_ALLOW_PRIVATE_DESTINATIONS: "true",
        NODE_ENV: "production",
      }),
    ).toEqual({});
  });
});

describe("resolvePublicAddresses", () => {
  const answers =
    (...addresses: string[]): Resolver =>
    async () =>
      addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

  it("returns the addresses when all of them are public", async () => {
    const found = await resolvePublicAddresses(
      "example.com",
      {},
      answers("93.184.216.34", "2606:4700::1"),
    );
    expect(found.map((a) => a.address)).toEqual(["93.184.216.34", "2606:4700::1"]);
  });

  it("refuses a name that resolves to a private address", async () => {
    for (const address of ["127.0.0.1", "10.0.0.8", "169.254.169.254", "::1", "fd00::8"]) {
      await expect(
        resolvePublicAddresses("evil.example", {}, answers(address)),
      ).rejects.toMatchObject({
        reason: "private_address",
      });
    }
  });

  it("refuses when even one of several addresses is private", async () => {
    await expect(
      resolvePublicAddresses("mixed.example", {}, answers("93.184.216.34", "10.0.0.8")),
    ).rejects.toMatchObject({ reason: "private_address" });
  });

  it("refuses a name that does not resolve, or resolves to nothing", async () => {
    const failing: Resolver = async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    };
    await expect(resolvePublicAddresses("nope.example", {}, failing)).rejects.toMatchObject({
      reason: "unresolvable",
    });
    await expect(resolvePublicAddresses("empty.example", {}, answers())).rejects.toMatchObject({
      reason: "unresolvable",
    });
  });

  it("allows private addresses only under the relaxed policy", async () => {
    const found = await resolvePublicAddresses(
      "dev.local",
      { allowPrivate: true },
      answers("127.0.0.1"),
    );
    expect(found).toEqual([{ address: "127.0.0.1", family: 4 }]);
  });
});

describe("postJson", () => {
  let server: Server;
  let base: string;
  const seen: { method: string; url: string; headers: IncomingMessage["headers"]; body: string }[] =
    [];
  const relaxed = { allowHttp: true, allowPrivate: true };

  beforeAll(async () => {
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString()));
      request.on("end", () => {
        seen.push({ method: request.method!, url: request.url!, headers: request.headers, body });
        if (request.url === "/slow") return; // never answers
        if (request.url === "/redirect") {
          response.writeHead(302, { location: `${base}/redirected` }).end();
        } else if (request.url === "/huge") {
          response.writeHead(200);
          response.end(Buffer.alloc(5 * 1024 * 1024, "x"));
        } else if (request.url?.startsWith("/status/")) {
          response.writeHead(Number(request.url.slice(8))).end("secret-looking response body");
        } else {
          response.writeHead(204).end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it("posts the body as JSON with the given headers and returns the status", async () => {
    const result = await postJson(`${base}/hook?x=1`, {
      body: '{"hello":"wörld"}',
      headers: { "webhook-id": "abc" },
      policy: relaxed,
    });
    expect(result).toEqual({ status: 204 });
    const request = seen.at(-1)!;
    expect(request).toMatchObject({ method: "POST", url: "/hook?x=1", body: '{"hello":"wörld"}' });
    expect(request.headers).toMatchObject({
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength('{"hello":"wörld"}')),
      "webhook-id": "abc",
    });
  });

  it("returns error statuses as statuses, and never the response body", async () => {
    for (const status of [400, 401, 404, 410, 429, 500, 503]) {
      const result = await postJson(`${base}/status/${status}`, { body: "{}", policy: relaxed });
      expect(result).toEqual({ status });
      expect(JSON.stringify(result)).not.toContain("secret-looking");
    }
  });

  it("does not follow a redirect", async () => {
    const before = seen.length;
    const result = await postJson(`${base}/redirect`, { body: "{}", policy: relaxed });
    expect(result.status).toBe(302);
    expect(seen.slice(before).map((request) => request.url)).toEqual(["/redirect"]);
  });

  it("gives up when the destination does not answer in time", async () => {
    const started = Date.now();
    await expect(
      postJson(`${base}/slow`, { body: "{}", policy: relaxed, timeoutMs: 150 }),
    ).rejects.toMatchObject({ name: "OutboundFailedError", reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("does not read an enormous response to the end", async () => {
    const started = Date.now();
    const result = await postJson(`${base}/huge`, { body: "{}", policy: relaxed });
    expect(result.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("reports a destination that refuses the connection", async () => {
    await expect(
      postJson("http://127.0.0.1:1/hook", { body: "{}", policy: relaxed }),
    ).rejects.toBeInstanceOf(OutboundFailedError);
  });

  it("refuses a private destination under the normal policy, without connecting", async () => {
    const before = seen.length;
    const port = new URL(base).port;
    await expect(postJson(`${base}/hook`, { body: "{}" })).rejects.toMatchObject({
      reason: "not_https",
    });
    await expect(postJson(`https://127.0.0.1:${port}/hook`, { body: "{}" })).rejects.toMatchObject({
      reason: "private_address",
    });
    expect(seen).toHaveLength(before);
  });

  it("refuses a public-looking name that resolves to this machine, without connecting", async () => {
    const before = seen.length;
    const port = new URL(base).port;
    const rebinding: Resolver = async () => [{ address: "127.0.0.1", family: 4 }];
    await expect(
      postJson(`http://hooks.example.com:${port}/hook`, {
        body: "{}",
        policy: { allowHttp: true },
        resolver: rebinding,
      }),
    ).rejects.toMatchObject({ name: "OutboundRefusedError", reason: "private_address" });
    expect(seen).toHaveLength(before);
  });

  it("connects to the address that was checked, not to a second answer", async () => {
    // A resolver that answers with this machine the first time and would
    // answer differently afterwards. Only one lookup is ever made.
    let lookups = 0;
    const once: Resolver = async () => {
      lookups += 1;
      return [{ address: lookups === 1 ? "127.0.0.1" : "203.0.113.7", family: 4 }];
    };
    const port = new URL(base).port;
    const result = await postJson(`http://hooks.example.com:${port}/hook`, {
      body: "{}",
      policy: relaxed,
      resolver: once,
    });
    expect(result.status).toBe(204);
    expect(lookups).toBe(1);
    expect(seen.at(-1)!.headers.host).toBe(`hooks.example.com:${port}`);
  });
});
