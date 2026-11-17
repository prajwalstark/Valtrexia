import { describe, expect, it } from "vitest";
import { AuthError, InvalidResponseError, NetworkError, VendorError } from "../errors";
import { UNIVIEW_API_BASE_URL, UNIVIEW_PAGE_SIZE, UniviewConnector } from "./connector";
import { univiewCredentialHint, univiewCredentialsSchema } from "./credentials";
import {
  ACME,
  ASSET_DC,
  ASSET_FS,
  ASSET_NEW,
  ASSET_SQL,
  BIRCH,
  FIXTURE_CLIENT_ID,
  FIXTURE_CLIENT_SECRET,
  FIXTURE_TOKEN,
  fakeUniview,
  univiewFixture,
} from "./fixtures";
import { normalizeUniviewStatus } from "./normalize";
import { parseUniviewTimestamp } from "./schema";
import { fetchUniviewToken, UNIVIEW_TOKEN_URL } from "./token";

const credentials = { clientId: FIXTURE_CLIENT_ID, clientSecret: FIXTURE_CLIENT_SECRET };
const quick = { sleep: async () => {}, random: () => 0, maxRetries: 1 };
const connectorFor = (fake = fakeUniview()) => ({
  fake,
  connector: new UniviewConnector(credentials, { fetch: fake.fetch, ...quick }),
});
const apiRequests = (fake: ReturnType<typeof fakeUniview>) =>
  fake.requests.filter((r) => r.url.origin === UNIVIEW_API_BASE_URL);

describe("uniview connector: clients", () => {
  it("lists customers by name", async () => {
    const { connector } = connectorFor();
    expect(await connector.listClients()).toEqual([
      { vendorClientId: ACME, name: "Acme Dental" },
      { vendorClientId: BIRCH, name: "Birch Law" },
    ]);
  });

  it("names a customer without a name by its id", async () => {
    const fixture = univiewFixture();
    fixture.customers[0]!.name = "  ";
    const clients = await connectorFor(fakeUniview(fixture)).connector.listClients();
    expect(clients.map((c) => c.name)).toContain("Customer 22222222");
  });
});

describe("uniview connector: assets", () => {
  it("lists a customer's assets, named for the appliance protecting them", async () => {
    const { connector } = connectorFor();
    const assets = await connector.listAssets(ACME);
    expect(assets.map((a) => [a.vendorAssetId, a.name, a.type, a.deviceName]).sort()).toEqual(
      [
        [ASSET_SQL, "ACME-SQL01", "windows", "acme-ueb"],
        [ASSET_FS, "ACME-FS01", "vmware", "acme-ueb"],
        [ASSET_NEW, "ACME-NEW01", "hyper-v", "acme-ueb"],
      ].sort(),
    );
    expect(
      assets.every(
        (a) =>
          a.vendorClientId === ACME &&
          !a.isPaused &&
          !a.isArchived &&
          a.expectedFrequencyHours === null,
      ),
    ).toBe(true);
    expect((await connector.listAssets(BIRCH)).map((a) => a.vendorAssetId)).toEqual([ASSET_DC]);
    expect(await connector.listAssets("00000000-0000-4000-8000-00000000ffff")).toEqual([]);
  });

  it("names the appliance by its tag when UniView does not list it", async () => {
    const fixture = univiewFixture();
    fixture.appliances = [];
    const [dc] = await connectorFor(fakeUniview(fixture)).connector.listAssets(BIRCH);
    expect(dc!.deviceName).toBe("UB-BIRCH-01");
  });
});

describe("uniview connector: results", () => {
  const since = new Date("2026-11-01T00:00:00Z");

  it("reports each backup since `since`, with its status and a short note", async () => {
    const { connector } = connectorFor();
    const results = await connector.listResults(since);
    const byKey = Object.fromEntries(
      results.map((r) => [`${r.vendorAssetId}@${r.startedAt.toISOString()}`, r]),
    );
    expect(Object.keys(byKey).sort()).toEqual(
      [
        `${ASSET_SQL}@2026-11-10T01:00:00.000Z`,
        `${ASSET_SQL}@2026-11-12T01:00:05.123Z`,
        `${ASSET_FS}@2026-11-12T01:05:00.000Z`,
        `${ASSET_DC}@2026-11-12T11:30:00.000Z`,
      ].sort(),
    );

    const failed = byKey[`${ASSET_SQL}@2026-11-12T01:00:05.123Z`]!;
    expect(failed).toMatchObject({
      endedAt: new Date("2026-11-12T01:04:00Z"),
      vendorStatusRaw: "Failed",
      message: "Incremental backup",
      screenshotVerified: null,
    });
    expect(connector.normalizeStatus(failed.rawPayload)).toBe("failed");

    const warning = byKey[`${ASSET_FS}@2026-11-12T01:05:00.000Z`]!;
    expect(warning.message).toBe("Incremental backup. Replication to the target failed.");
    expect(connector.normalizeStatus(warning.rawPayload)).toBe("warning");

    const running = byKey[`${ASSET_DC}@2026-11-12T11:30:00.000Z`]!;
    expect(running.endedAt).toBeNull();
    expect(connector.normalizeStatus(running.rawPayload)).toBe("running");
  });

  it("asks UniView only for backups since `since`, oldest first", async () => {
    const { connector, fake } = connectorFor();
    await connector.listResults(since);
    const request = apiRequests(fake).find((r) => r.url.pathname === "/v1/backups")!;
    expect(request.url.searchParams.get("start_time_from")).toBe("2026-11-01T00:00:00.000Z");
    expect(request.url.searchParams.get("order_by")).toBe("start_time");
    expect(request.url.searchParams.get("order_direction")).toBe("asc");
  });

  it("skips a backup that started before `since`, even if UniView returns it", async () => {
    const fake = fakeUniview(univiewFixture(), {
      override: (url) =>
        url.pathname === "/v1/backups" && url.searchParams.get("page_number") === "1"
          ? Response.json(univiewFixture().backups)
          : undefined,
    });
    const results = await connectorFor(fake).connector.listResults(since);
    expect(results.map((r) => r.startedAt.toISOString())).not.toContain("2026-09-01T01:00:00.000Z");
    expect(results).toHaveLength(4);
  });

  it("gives a running backup no end time, even when UniView reports one", async () => {
    const fixture = univiewFixture();
    fixture.backups[3]!.complete_time = "2026-11-12T11:31:00Z";
    const results = await connectorFor(fakeUniview(fixture)).connector.listResults(since);
    expect(results.find((r) => r.vendorAssetId === ASSET_DC)!.endedAt).toBeNull();
  });

  it("gives a backup the same id while it runs and after it completes, and a new backup a new id", async () => {
    const before = await connectorFor().connector.listResults(since);
    const fixture = univiewFixture();
    fixture.backups[3]!.status = "Successful";
    fixture.backups[3]!.complete_time = "2026-11-12T12:00:00Z";
    const after = await connectorFor(fakeUniview(fixture)).connector.listResults(since);
    const key = (r: { vendorAssetId: string; vendorResultId: string }) =>
      `${r.vendorAssetId}|${r.vendorResultId}`;
    expect(after.map(key).sort()).toEqual(before.map(key).sort());

    fixture.backups.push({ ...fixture.backups[1]!, start_time: "2026-11-13T01:00:00Z" });
    const next = await connectorFor(fakeUniview(fixture)).connector.listResults(since);
    const known = new Set(before.map(key));
    expect(next.filter((r) => !known.has(key(r)))).toHaveLength(1);
  });

  it("keeps a full and an incremental backup that started together apart", async () => {
    const fixture = univiewFixture();
    fixture.backups.push({ ...fixture.backups[1]!, type: "Full" });
    const results = await connectorFor(fakeUniview(fixture)).connector.listResults(since);
    expect(
      results.filter((r) => r.startedAt.toISOString() === "2026-11-12T01:00:05.123Z"),
    ).toHaveLength(2);
  });

  it("keeps the record as received, as the raw payload", async () => {
    const results = await connectorFor().connector.listResults(since);
    expect(results[0]!.rawPayload).toMatchObject({
      size: 1_048_576,
      asset_tag: expect.any(String) as string,
    });
  });
});

describe("uniview connector: the wire", () => {
  it("gets one token with client credentials, then only GETs with it as a bearer", async () => {
    const { connector, fake } = connectorFor();
    for (const client of await connector.listClients()) {
      await connector.listAssets(client.vendorClientId);
    }
    await connector.listResults(new Date(0));

    const [token, ...rest] = fake.requests;
    expect(token!.method).toBe("POST");
    expect(token!.url.href).toBe(UNIVIEW_TOKEN_URL);
    expect(token!.body).toBe("grant_type=client_credentials");
    expect(fake.tokensIssued()).toBe(1);
    expect(rest.length).toBeGreaterThan(0);
    for (const request of rest) {
      expect(request.url.origin).toBe(UNIVIEW_API_BASE_URL);
      expect(request.method).toBe("GET");
      expect(request.headers.get("authorization")).toBe(`Bearer ${FIXTURE_TOKEN}`);
    }
  });

  it("fetches each list once per sync, however many clients there are", async () => {
    const { connector, fake } = connectorFor();
    for (const client of await connector.listClients()) {
      await connector.listAssets(client.vendorClientId);
    }
    await connector.listResults(new Date(0));
    expect(
      apiRequests(fake)
        .map((r) => r.url.pathname)
        .sort(),
    ).toEqual(["/v1/appliances", "/v1/assets", "/v1/backups", "/v1/customers"]);
  });

  it("pages with page_number and page_size until a short page", async () => {
    const fixture = univiewFixture();
    const base = fixture.assets[0]!;
    fixture.assets = Array.from({ length: 2 * UNIVIEW_PAGE_SIZE + 3 }, (_, i) => ({
      ...base,
      key: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`,
      name: `PC-${i}`,
    }));
    const { connector, fake } = connectorFor(fakeUniview(fixture));
    expect(await connector.listAssets(ACME)).toHaveLength(2 * UNIVIEW_PAGE_SIZE + 3);
    const pages = apiRequests(fake).filter((r) => r.url.pathname === "/v1/assets");
    expect(
      pages.map((r) => [
        r.url.searchParams.get("page_number"),
        r.url.searchParams.get("page_size"),
      ]),
    ).toEqual([
      ["1", "50"],
      ["2", "50"],
      ["3", "50"],
    ]);
    // A stable order, so a page cannot repeat or skip an item.
    expect(pages.every((r) => r.url.searchParams.get("order_by") === "key")).toBe(true);
  });

  it("reads one more, empty page when the last one is exactly full", async () => {
    const fixture = univiewFixture();
    const base = fixture.assets[0]!;
    fixture.assets = Array.from({ length: UNIVIEW_PAGE_SIZE }, (_, i) => ({
      ...base,
      key: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`,
    }));
    const { connector, fake } = connectorFor(fakeUniview(fixture));
    expect(await connector.listAssets(ACME)).toHaveLength(UNIVIEW_PAGE_SIZE);
    expect(apiRequests(fake).filter((r) => r.url.pathname === "/v1/assets")).toHaveLength(2);
  });

  it("tests a connection with a token and a single customer", async () => {
    const { connector, fake } = connectorFor();
    await connector.testConnection();
    expect(
      fake.requests.map((r) => [r.method, r.url.pathname, r.url.searchParams.get("page_size")]),
    ).toEqual([
      ["POST", "/connect/token", null],
      ["GET", "/v1/customers", "1"],
    ]);
  });

  it("reports a rejected client ID or secret as an authentication failure", async () => {
    const fake = fakeUniview(univiewFixture(), { clientSecret: "a-different-secret-entirely" });
    await expect(connectorFor(fake).connector.testConnection()).rejects.toBeInstanceOf(AuthError);
    expect(apiRequests(fake)).toHaveLength(0);
  });

  it("reports a token the API refuses as an authentication failure", async () => {
    const fake = fakeUniview(univiewFixture(), {
      override: (url) =>
        url.origin === UNIVIEW_API_BASE_URL ? new Response("{}", { status: 401 }) : undefined,
    });
    await expect(connectorFor(fake).connector.listClients()).rejects.toBeInstanceOf(AuthError);
  });

  it("treats server errors as a vendor error, after retrying", async () => {
    let calls = 0;
    const fake = fakeUniview(univiewFixture(), {
      override: (url) => {
        if (url.origin !== UNIVIEW_API_BASE_URL) return undefined;
        calls += 1;
        return new Response("{}", { status: 503 });
      },
    });
    await expect(connectorFor(fake).connector.testConnection()).rejects.toBeInstanceOf(VendorError);
    expect(calls).toBe(2);
  });

  it("refuses a response that is not a list", async () => {
    const fake = fakeUniview(univiewFixture(), {
      override: (url) =>
        url.pathname === "/v1/customers" ? Response.json({ items: [] }) : undefined,
    });
    await expect(connectorFor(fake).connector.listClients()).rejects.toBeInstanceOf(
      InvalidResponseError,
    );
  });

  it("skips an unreadable item instead of failing the sync", async () => {
    const fixture = univiewFixture();
    fixture.assets.push({ customer_id: ACME, name: "missing key" });
    const assets = await connectorFor(fakeUniview(fixture)).connector.listAssets(ACME);
    expect(assets.map((a) => a.name)).not.toContain("missing key");
    expect(assets).toHaveLength(3);
  });
});

describe("uniview token", () => {
  it("sends the ID and secret as Basic auth and the grant as a form", async () => {
    const fake = fakeUniview();
    expect(await fetchUniviewToken(credentials, { fetch: fake.fetch })).toBe(FIXTURE_TOKEN);
    const [request] = fake.requests;
    expect(request!.headers.get("authorization")).toBe(
      `Basic ${Buffer.from(`${FIXTURE_CLIENT_ID}:${FIXTURE_CLIENT_SECRET}`).toString("base64")}`,
    );
    expect(request!.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
  });

  it("retries a server error, then gives up as a vendor error", async () => {
    let calls = 0;
    const doFetch = (async () => {
      calls += 1;
      return new Response("", { status: 502 });
    }) as typeof fetch;
    await expect(
      fetchUniviewToken(credentials, { fetch: doFetch, sleep: async () => {}, maxRetries: 2 }),
    ).rejects.toBeInstanceOf(VendorError);
    expect(calls).toBe(3);
  });

  it("reports a network failure, and a reply with no token", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(
      fetchUniviewToken(credentials, { fetch: down, sleep: async () => {}, maxRetries: 0 }),
    ).rejects.toBeInstanceOf(NetworkError);
    const empty = (async () => Response.json({ token_type: "Bearer" })) as typeof fetch;
    await expect(fetchUniviewToken(credentials, { fetch: empty })).rejects.toBeInstanceOf(
      InvalidResponseError,
    );
  });

  it("does not follow a redirect, and never logs the token or the secret", async () => {
    const lines: unknown[] = [];
    const logger = {
      debug: (...args: unknown[]) => lines.push(args),
      info: (...args: unknown[]) => lines.push(args),
      warn: (...args: unknown[]) => lines.push(args),
      error: (...args: unknown[]) => lines.push(args),
    } as never;
    const fake = fakeUniview();
    const { connector } = {
      connector: new UniviewConnector(credentials, { fetch: fake.fetch, logger, ...quick }),
    };
    await connector.listResults(new Date(0));
    const logged = JSON.stringify(lines);
    expect(logged).not.toContain(FIXTURE_TOKEN);
    expect(logged).not.toContain(FIXTURE_CLIENT_SECRET);

    let init: RequestInit | undefined;
    const spy = (async (_: unknown, i?: RequestInit) => {
      init = i;
      return Response.json({ access_token: "t" });
    }) as typeof fetch;
    await fetchUniviewToken(credentials, { fetch: spy });
    expect(init?.redirect).toBe("manual");
  });

  it("refuses a redirect as a vendor error instead of following it", async () => {
    const moved = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://elsewhere.example/" },
      })) as typeof fetch;
    await expect(fetchUniviewToken(credentials, { fetch: moved })).rejects.toBeInstanceOf(
      VendorError,
    );
  });
});

describe("uniview credentials", () => {
  it("trims, validates, and gives a hint of the client ID's last four characters", () => {
    const parsed = univiewCredentialsSchema.parse({
      clientId: ` ${FIXTURE_CLIENT_ID} `,
      clientSecret: FIXTURE_CLIENT_SECRET,
    });
    expect(parsed).toEqual(credentials);
    expect(univiewCredentialHint(parsed)).toBe("0001");
    for (const bad of ["short", "has a space in it 0123456789", "x".repeat(513)]) {
      expect(
        univiewCredentialsSchema.safeParse({ ...credentials, clientSecret: bad }).success,
      ).toBe(false);
      expect(univiewCredentialsSchema.safeParse({ ...credentials, clientId: bad }).success).toBe(
        false,
      );
    }
    expect(univiewCredentialsSchema.safeParse({ ...credentials, extra: "field" }).success).toBe(
      false,
    );
  });
});

describe("uniview normalization", () => {
  it("maps every backup status in the specification", () => {
    expect(
      ["Successful", "Warning", "Failed", "InProgress", "Unknown"].map((status) =>
        normalizeUniviewStatus({ status }),
      ),
    ).toEqual(["success", "warning", "failed", "running", "unknown"]);
  });

  it("does not let replication change a backup's own status", () => {
    expect(normalizeUniviewStatus({ status: "Successful", replication_status: "Failed" })).toBe(
      "success",
    );
  });

  it("calls anything it does not know unknown, and never throws", () => {
    for (const raw of [
      null,
      undefined,
      1,
      "Successful",
      [],
      {},
      { status: "Exploded" },
      { status: 7 },
      { status: "toString" },
      { status: "constructor" },
      { status: "__proto__" },
    ]) {
      expect(normalizeUniviewStatus(raw)).toBe("unknown");
    }
  });

  it("reads timestamps with an offset, without one as UTC, and nonsense as nothing", () => {
    expect(parseUniviewTimestamp("2026-11-12T03:00:00+02:00")).toEqual(
      new Date("2026-11-12T01:00:00Z"),
    );
    expect(parseUniviewTimestamp("2026-11-12T01:00:00")).toEqual(new Date("2026-11-12T01:00:00Z"));
    expect(parseUniviewTimestamp("2026-11-12T01:00:00.5Z")).toEqual(
      new Date("2026-11-12T01:00:00.500Z"),
    );
    for (const never of ["0001-01-01T00:00:00", "", null, undefined, "soon"]) {
      expect(parseUniviewTimestamp(never)).toBeNull();
    }
  });
});
