/**
 * A stand-in for the Kaseya UniView public API for tests and the demo,
 * answering the token endpoint and the four lists the connector reads with
 * records shaped as Kaseya's OpenAPI specification (public_api-v1) describes.
 *
 * It behaves as the documentation says the service does: a token is issued
 * for the client ID and secret sent as HTTP Basic auth with
 * `grant_type=client_credentials`; lists require that token as a bearer,
 * page with `page_number` and `page_size` (default 50), return a plain JSON
 * array with paging totals in headers, honour `customer_id`, `asset_tag` and
 * `start_time_from`, and order by `order_by`. Anything but GET on the API
 * answers 405.
 */

import { UNIVIEW_API_BASE_URL } from "./connector";
import { UNIVIEW_TOKEN_URL } from "./token";

export const FIXTURE_CLIENT_ID = "fixture-uniview-client-0001";
export const FIXTURE_CLIENT_SECRET = "fixture-uniview-secret-0123456789abcdef";
export const FIXTURE_TOKEN = "fixture-uniview-access-token";

export const TOKEN_URL = UNIVIEW_TOKEN_URL;
export const API_BASE = UNIVIEW_API_BASE_URL;

export const ACME = "11111111-1111-4111-8111-111111111111";
export const BIRCH = "22222222-2222-4222-8222-222222222222";

export const APPLIANCE_ACME = "UB-ACME-01";
export const APPLIANCE_BIRCH = "UB-BIRCH-01";

export const ASSET_SQL = "aaaaaaaa-0000-4000-8000-000000000001";
export const ASSET_FS = "aaaaaaaa-0000-4000-8000-000000000002";
export const ASSET_NEW = "aaaaaaaa-0000-4000-8000-000000000003";
export const ASSET_DC = "aaaaaaaa-0000-4000-8000-000000000004";

export interface UniviewFixture {
  customers: Record<string, unknown>[];
  appliances: Record<string, unknown>[];
  assets: Record<string, unknown>[];
  backups: Record<string, unknown>[];
}

/** Two customers, one appliance each, and a few days of backups. */
export function univiewFixture(): UniviewFixture {
  const asset = (
    customer: string,
    applianceTag: string,
    key: string,
    name: string,
    type: string,
    last: Record<string, unknown> | null,
  ) => ({
    customer_id: customer,
    asset_tag: applianceTag,
    name,
    type,
    ip: "10.0.0.10",
    mac: "00:11:22:33:44:55",
    key,
    last_backup: last,
    links: [],
  });
  const backup = (
    customer: string,
    applianceTag: string,
    key: string,
    status: string,
    start: string,
    complete: string | null,
    extra: Record<string, unknown> = {},
  ) => ({
    customer_id: customer,
    asset_tag: applianceTag,
    asset_key: key,
    start_time: start,
    complete_time: complete,
    size: 1_048_576,
    type: "Incremental",
    status,
    replication_status: "Successful",
    ...extra,
  });

  return {
    customers: [
      { id: BIRCH, name: "Birch Law" },
      { id: ACME, name: "Acme Dental" },
    ],
    appliances: [
      {
        customer_id: ACME,
        asset_tag: APPLIANCE_ACME,
        name: "acme-ueb",
        is_online: true,
        total_mb_size: 4_000_000,
        total_mb_free: 1_000_000,
        version: "10.8.1",
        helix_status: "Ok",
      },
      {
        customer_id: BIRCH,
        asset_tag: APPLIANCE_BIRCH,
        name: "birch-recovery-936",
        is_online: false,
        total_mb_size: 2_000_000,
        total_mb_free: 500_000,
        version: "10.7.9",
        helix_status: "Ok",
      },
    ],
    assets: [
      asset(ACME, APPLIANCE_ACME, ASSET_SQL, "ACME-SQL01", "Windows", null),
      asset(ACME, APPLIANCE_ACME, ASSET_FS, "ACME-FS01", "VMware", null),
      asset(ACME, APPLIANCE_ACME, ASSET_NEW, "ACME-NEW01", "Hyper-V", null),
      asset(BIRCH, APPLIANCE_BIRCH, ASSET_DC, "BIRCH-DC01", "Windows", null),
    ],
    backups: [
      backup(
        ACME,
        APPLIANCE_ACME,
        ASSET_SQL,
        "Successful",
        "2026-11-10T01:00:00Z",
        "2026-11-10T01:20:00Z",
        {
          type: "Full",
        },
      ),
      backup(
        ACME,
        APPLIANCE_ACME,
        ASSET_SQL,
        "Failed",
        "2026-11-12T01:00:05.123Z",
        "2026-11-12T01:04:00Z",
      ),
      backup(
        ACME,
        APPLIANCE_ACME,
        ASSET_FS,
        "Warning",
        "2026-11-12T01:05:00Z",
        "2026-11-12T01:30:00Z",
        {
          replication_status: "Failed",
        },
      ),
      backup(BIRCH, APPLIANCE_BIRCH, ASSET_DC, "InProgress", "2026-11-12T11:30:00Z", null),
      // Older than any sync asks for.
      backup(
        BIRCH,
        APPLIANCE_BIRCH,
        ASSET_DC,
        "Successful",
        "2026-09-01T01:00:00Z",
        "2026-09-01T01:30:00Z",
      ),
    ],
  };
}

const LISTS: Record<string, keyof UniviewFixture> = {
  "v1/customers": "customers",
  "v1/appliances": "appliances",
  "v1/assets": "assets",
  "v1/backups": "backups",
};

const FILTERS = ["customer_id", "asset_tag", "asset_key", "status", "type"] as const;

export interface FakeUniview {
  fetch: typeof fetch;
  requests: { method: string; url: URL; headers: Headers; body: string | null }[];
  /** Tokens issued so far. */
  tokensIssued: () => number;
}

/**
 * A `fetch` that answers as UniView's token and API hosts would. Responses
 * can be replaced per path for tests of failures.
 */
export function fakeUniview(
  fixture: UniviewFixture = univiewFixture(),
  options: {
    clientId?: string;
    clientSecret?: string;
    override?: (url: URL, method: string) => Response | undefined;
  } = {},
): FakeUniview {
  const clientId = options.clientId ?? FIXTURE_CLIENT_ID;
  const clientSecret = options.clientSecret ?? FIXTURE_CLIENT_SECRET;
  const requests: FakeUniview["requests"] = [];
  let issued = 0;
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });

  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : null;
    requests.push({ method, url, headers, body });

    const overridden = options.override?.(url, method);
    if (overridden) return overridden;

    if (url.href === TOKEN_URL) {
      if (method !== "POST") return json({ error: "invalid_request" }, 405);
      const expected = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
      if (
        headers.get("authorization") !== expected ||
        headers.get("content-type") !== "application/x-www-form-urlencoded"
      ) {
        return json({ error: "invalid_client" }, 400);
      }
      if (new URLSearchParams(body ?? "").get("grant_type") !== "client_credentials") {
        return json({ error: "unsupported_grant_type" }, 400);
      }
      issued += 1;
      return json({ access_token: FIXTURE_TOKEN, token_type: "Bearer", expires_in: 3600 });
    }

    if (url.origin !== API_BASE) return json({ title: "Not Found" }, 404);
    if (method !== "GET") return json({ title: "Method Not Allowed" }, 405);
    if (headers.get("authorization") !== `Bearer ${FIXTURE_TOKEN}`) {
      return json({ title: "Unauthorized", status: 401 }, 401);
    }
    const name = LISTS[url.pathname.slice(1)];
    if (!name) return json({ title: "Not Found", status: 404 }, 404);

    let items = fixture[name];
    for (const filter of FILTERS) {
      const value = url.searchParams.get(filter);
      if (value !== null) items = items.filter((item) => item[filter] === value);
    }
    const from = url.searchParams.get("start_time_from");
    if (from)
      items = items.filter((item) => Date.parse(String(item.start_time)) >= Date.parse(from));
    const orderBy = url.searchParams.get("order_by");
    if (orderBy) {
      const sign = url.searchParams.get("order_direction") === "desc" ? -1 : 1;
      items = [...items].sort(
        (a, b) => sign * String(a[orderBy]).localeCompare(String(b[orderBy])),
      );
    }
    const pageNumber = Number(url.searchParams.get("page_number") ?? 1);
    const pageSize = Number(url.searchParams.get("page_size") ?? 50);
    const page = items.slice((pageNumber - 1) * pageSize, pageNumber * pageSize);
    return json(page, 200, {
      "paging-total-records": String(items.length),
      "paging-total-pages": String(Math.ceil(items.length / pageSize)),
      "paging-page-size": String(pageSize),
      "paging-page-number": String(pageNumber),
    });
  }) as typeof fetch;

  return { fetch: fetchImpl, requests, tokensIssued: () => issued };
}
