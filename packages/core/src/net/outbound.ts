import { lookup as dnsLookup } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

/**
 * Outbound requests to addresses a tenant typed in: a webhook URL, a vendor
 * server of their own.
 *
 * The danger is that the server, not the tenant, makes the connection. A URL
 * that points at 127.0.0.1, at a private range or at a cloud metadata address
 * would be fetched from inside our network on the tenant's behalf. So:
 *
 *   - only https, no credentials in the URL, and a port that is 443 or
 *     unprivileged;
 *   - the hostname is resolved once, every address it resolves to must be
 *     public, and the connection is made to those same addresses. The check
 *     and the connection share one DNS answer, so a second answer cannot
 *     swap the target after the check;
 *   - redirects are never followed, the wait is bounded, and only a bounded
 *     amount of any response is read.
 */

export type OutboundRefusal =
  | "malformed"
  | "not_https"
  | "has_credentials"
  | "port_not_allowed"
  | "private_address"
  | "unresolvable";

const REFUSAL_MESSAGE: Record<OutboundRefusal, string> = {
  malformed: "That is not a valid URL.",
  not_https: "The URL must start with https://.",
  has_credentials: "The URL must not contain a user name or password.",
  port_not_allowed: "The URL's port must be 443, or 1024 or above.",
  private_address: "The URL must point to a public address, not a private or internal one.",
  unresolvable: "The URL's host name could not be found.",
};

/** A destination we will not connect to. The message is written to be shown to the person who entered it. */
export class OutboundRefusedError extends Error {
  constructor(readonly reason: OutboundRefusal) {
    super(REFUSAL_MESSAGE[reason]);
    this.name = "OutboundRefusedError";
  }
}

/** The request was made and did not complete: no connection, a TLS failure, or no answer in time. */
export class OutboundFailedError extends Error {
  constructor(readonly reason: "timeout" | "connection" | "tls") {
    super(
      reason === "timeout"
        ? "The destination did not answer in time."
        : reason === "tls"
          ? "The destination's certificate could not be verified."
          : "The destination could not be reached.",
    );
    this.name = "OutboundFailedError";
  }
}

/**
 * Loosens the rules. For tests and local development only: nothing in the
 * production wiring sets either, and `outboundPolicyFromEnv` refuses to.
 */
export interface OutboundPolicy {
  /** Allow loopback, private and other non-public addresses. */
  allowPrivate?: boolean;
  /** Allow plain http. */
  allowHttp?: boolean;
}

/**
 * The policy for this process. Private destinations and plain http can be
 * allowed for local development, to send a webhook to a receiver on the same
 * machine. Never in production, whatever the variable says.
 */
export function outboundPolicyFromEnv(env: {
  NODE_ENV?: string | undefined;
  VALTREXIA_ALLOW_PRIVATE_DESTINATIONS?: string | undefined;
}): OutboundPolicy {
  const allowed =
    env.VALTREXIA_ALLOW_PRIVATE_DESTINATIONS === "true" && env.NODE_ENV !== "production";
  return allowed ? { allowPrivate: true, allowHttp: true } : {};
}

// One list per family. A single BlockList matches an IPv4 address against
// IPv4-mapped IPv6 rules too, so "::ffff:0:0/96" below would block every
// IPv4 address if the two shared a list.
const blockedV4 = new BlockList();
const blockedV6 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, including cloud metadata (169.254.169.254)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, and broadcast
] as const) {
  blockedV4.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["::ffff:0:0", 96], // IPv4-mapped: an IPv4 address in disguise
  ["64:ff9b::", 96], // NAT64: reaches an IPv4 address
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard
  ["2001::", 32], // Teredo
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4: embeds an IPv4 address
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
] as const) {
  blockedV6.addSubnet(network, prefix, "ipv6");
}

/** Whether an IP address, written as a literal, is one on the public internet. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return family === 4 ? !blockedV4.check(address, "ipv4") : !blockedV6.check(address, "ipv6");
}

/**
 * Checks a URL before anything is resolved or connected: its scheme, that it
 * carries no credentials, its port, and its address if the host is an IP
 * literal. Returns the parsed URL.
 *
 * @throws OutboundRefusedError
 */
export function parseOutboundUrl(raw: string, policy: OutboundPolicy = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OutboundRefusedError("malformed");
  }
  if (url.protocol !== "https:" && !(policy.allowHttp && url.protocol === "http:")) {
    throw new OutboundRefusedError("not_https");
  }
  if (url.username !== "" || url.password !== "") throw new OutboundRefusedError("has_credentials");
  if (url.hostname === "") throw new OutboundRefusedError("malformed");

  if (!policy.allowPrivate) {
    const port = url.port === "" ? 443 : Number(url.port);
    if (port !== 443 && port < 1024) throw new OutboundRefusedError("port_not_allowed");
    // The URL parser has already normalized other spellings of an address
    // (decimal, hex, short forms) into dotted or bracketed form.
    const literal = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(literal) !== 0 && !isPublicAddress(literal)) {
      throw new OutboundRefusedError("private_address");
    }
  }
  return url;
}

export interface ResolvedAddress {
  address: string;
  family: number;
}
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

const systemResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true }, (error, addresses) =>
      error ? reject(error) : resolve(addresses),
    );
  });

/**
 * Resolves a host name and refuses it unless every address is public. One
 * private address among public ones is enough to refuse: which of several
 * addresses a connection uses is not ours to choose.
 *
 * @throws OutboundRefusedError
 */
export async function resolvePublicAddresses(
  hostname: string,
  policy: OutboundPolicy = {},
  resolver: Resolver = systemResolver,
): Promise<ResolvedAddress[]> {
  let addresses: ResolvedAddress[];
  try {
    addresses = await resolver(hostname);
  } catch {
    throw new OutboundRefusedError("unresolvable");
  }
  if (addresses.length === 0) throw new OutboundRefusedError("unresolvable");
  if (!policy.allowPrivate && !addresses.every(({ address }) => isPublicAddress(address))) {
    throw new OutboundRefusedError("private_address");
  }
  return addresses;
}

/**
 * A DNS lookup for the socket that resolves once, refuses any non-public
 * address, and hands the socket exactly the addresses it checked. An IP
 * literal never reaches it; that was checked when the URL was parsed.
 * `refusal()` says why a lookup was refused, once it has been.
 */
function pinnedLookup(
  policy: OutboundPolicy,
  resolver: Resolver | undefined,
): { lookup: LookupFunction; refusal: () => OutboundRefusedError | undefined } {
  let refused: OutboundRefusedError | undefined;
  const lookup: LookupFunction = (hostname, lookupOptions, callback) => {
    resolvePublicAddresses(hostname, policy, resolver).then(
      (addresses) => {
        if (typeof lookupOptions === "object" && lookupOptions.all) {
          callback(null, addresses);
        } else {
          callback(null, addresses[0]!.address, addresses[0]!.family);
        }
      },
      (error: unknown) => {
        if (error instanceof OutboundRefusedError) refused = error;
        callback(error as NodeJS.ErrnoException, "", 0);
      },
    );
  };
  return { lookup, refusal: () => refused };
}

export interface PostJsonOptions {
  headers?: Record<string, string>;
  /** The request body, already serialized. */
  body: string;
  /** How long the whole request may take. Default 10 seconds. */
  timeoutMs?: number;
  policy?: OutboundPolicy;
  /** Replaces DNS. For tests. */
  resolver?: Resolver;
}

const MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * POSTs a JSON body to a tenant-supplied URL under the rules above, and
 * returns the status code. The response body is read only to let the
 * connection finish, never returned: what a tenant's endpoint answers has no
 * business in our logs or on anyone's screen.
 *
 * @throws OutboundRefusedError when the destination is not allowed
 * @throws OutboundFailedError when the request could not be completed
 */
export async function postJson(raw: string, options: PostJsonOptions): Promise<{ status: number }> {
  const policy = options.policy ?? {};
  const url = parseOutboundUrl(raw, policy);
  const timeoutMs = options.timeoutMs ?? 10_000;

  const { lookup, refusal } = pinnedLookup(policy, options.resolver);

  const send = url.protocol === "http:" ? httpRequest : httpsRequest;
  return new Promise((resolve, reject) => {
    const request = send(
      url,
      {
        method: "POST",
        // A new connection each time, so each request is resolved and checked afresh.
        agent: false,
        lookup,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(options.body),
          ...options.headers,
        },
      },
      (response) => {
        let received = 0;
        response.on("data", (chunk: Buffer) => {
          received += chunk.length;
          // Enough has been read to know the outcome. Stop listening.
          if (received > MAX_RESPONSE_BYTES) response.destroy();
        });
        const done = () => {
          clearTimeout(timer);
          resolve({ status: response.statusCode ?? 0 });
        };
        response.on("end", done);
        response.on("close", done);
        response.on("error", done);
      },
    );
    const timer = setTimeout(() => {
      request.destroy(new OutboundFailedError("timeout"));
    }, timeoutMs);

    request.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (refusal()) reject(refusal());
      else if (error instanceof OutboundFailedError) reject(error);
      else if (/CERT|SELF_SIGNED|ERR_TLS|UNABLE_TO_VERIFY/i.test(error.code ?? "")) {
        reject(new OutboundFailedError("tls"));
      } else reject(new OutboundFailedError("connection"));
    });
    request.end(options.body);
  });
}

export interface GuardedFetchOptions {
  policy?: OutboundPolicy;
  /** Replaces DNS. For tests. */
  resolver?: Resolver;
  /** Largest response body read. A larger one fails the request. Default 25 MB. */
  maxResponseBytes?: number;
}

/**
 * A `fetch` for reading from a server a tenant named, such as their own
 * Veeam Service Provider Console. Same rules as `postJson`, in the shape the
 * vendor HTTP client already takes:
 *
 *   - GET only: anything else is refused before a connection is made, so the
 *     read-only guarantee holds here too;
 *   - https only (unless the policy relaxes it for local development), every
 *     resolved address public, the connection pinned to those addresses;
 *   - redirects are returned, never followed;
 *   - the body is read up to a limit, and the caller's abort signal is honoured.
 *
 * Refused destinations reject with `OutboundRefusedError`; connections that
 * fail, time out or fail TLS verification reject with `OutboundFailedError`.
 */
export function createGuardedFetch(options: GuardedFetchOptions = {}): typeof fetch {
  const policy = options.policy ?? {};
  const maxBytes = options.maxResponseBytes ?? 25 * 1024 * 1024;

  const guarded = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    if (method !== "GET") {
      return Promise.reject(
        new Error("Only GET requests can be made to a tenant-supplied server."),
      );
    }
    let url: URL;
    try {
      url = parseOutboundUrl(input instanceof Request ? input.url : String(input), policy);
    } catch (error) {
      return Promise.reject(error);
    }
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const { lookup, refusal } = pinnedLookup(policy, options.resolver);
    const send = url.protocol === "http:" ? httpRequest : httpsRequest;
    const signal = init?.signal ?? undefined;

    return new Promise<Response>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason instanceof Error ? signal.reason : new OutboundFailedError("timeout"));
        return;
      }
      const request = send(url, { method: "GET", agent: false, lookup, headers }, (response) => {
        const chunks: Buffer[] = [];
        let received = 0;
        response.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > maxBytes) {
            // Settle first: once a response has begun, destroying the request
            // does not raise an error event that would settle it for us.
            reject(new OutboundFailedError("connection"));
            response.destroy();
            request.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(response.headers)) {
            if (value === undefined) continue;
            for (const one of Array.isArray(value) ? value : [value])
              responseHeaders.append(key, one);
          }
          const status = response.statusCode ?? 0;
          // Statuses the Response constructor refuses are outside anything a server should send.
          if (status < 200 || status > 599) {
            reject(new OutboundFailedError("connection"));
            return;
          }
          const body = [101, 204, 205, 304].includes(status) ? null : Buffer.concat(chunks);
          resolve(new Response(body, { status, headers: responseHeaders }));
        });
        response.on("error", () => reject(new OutboundFailedError("connection")));
      });
      const onAbort = () => request.destroy(new OutboundFailedError("timeout"));
      signal?.addEventListener("abort", onAbort, { once: true });
      request.on("close", () => signal?.removeEventListener("abort", onAbort));
      request.on("error", (error: NodeJS.ErrnoException) => {
        const refused = refusal();
        if (refused) reject(refused);
        else if (error instanceof OutboundFailedError) reject(error);
        else if (/CERT|SELF_SIGNED|ERR_TLS|UNABLE_TO_VERIFY/i.test(error.code ?? "")) {
          reject(new OutboundFailedError("tls"));
        } else reject(new OutboundFailedError("connection"));
      });
      request.end();
    });
  };
  return guarded as typeof fetch;
}
