import { Writable } from "node:stream";
import { createLogger } from "@valtrexia/core/server";
import { describe, expect, it } from "vitest";
import { AuthError, InvalidResponseError, VendorError } from "../errors";
import { clientOf, DattoConnector } from "./connector";
import {
  fakeDatto,
  FIXTURE_NOW,
  fixtureAssets,
  fixtureDevices,
  type FakeDattoOptions,
} from "./fixtures";

const credentials = { publicKey: "fixture-public-9f3a", secretKey: "fixture-secret-do-not-use" };
const HOUR = 3_600_000;
const hoursBefore = (hours: number) => new Date(FIXTURE_NOW.getTime() - hours * HOUR);
const noWait = { sleep: async () => undefined, random: () => 0 };

function connect(options: FakeDattoOptions = {}, extra: Record<string, unknown> = {}) {
  const api = fakeDatto(options);
  const connector = new DattoConnector(credentials, { fetch: api.fetch, ...noWait, ...extra });
  return { api, connector };
}

const HDG = "company:harborview dental group";
const KFL = "org:4471";
const SPARE = "device:123456789ABC";

describe("datto connector: clients", () => {
  it("derives clients from the devices, one per customer, sorted by name", async () => {
    const { connector } = connect();
    expect(await connector.listClients()).toEqual([
      { vendorClientId: HDG, name: "Harborview Dental Group" },
      { vendorClientId: KFL, name: "Kestrel Freight & Logistics" },
      { vendorClientId: SPARE, name: "Spare unit" },
    ]);
  });

  it("treats two appliances with the same client name, differently capitalized, as one client", async () => {
    const { connector } = connect();
    const clients = await connector.listClients();
    expect(clients.filter((c) => c.vendorClientId === HDG)).toHaveLength(1);
  });

  it("maps a device to its client by name, then organization, then the device itself", () => {
    const device = (fields: Record<string, unknown>) => ({ serialNumber: "AA11", ...fields });
    expect(clientOf(device({ clientCompanyName: " Acme Ltd ", organizationId: 5 }))).toEqual({
      vendorClientId: "company:acme ltd",
      name: "Acme Ltd",
    });
    expect(
      clientOf(
        device({ clientCompanyName: "  ", organizationId: 5, organizationName: "Org Five" }),
      ),
    ).toEqual({
      vendorClientId: "org:5",
      name: "Org Five",
    });
    expect(clientOf(device({ organizationId: "abc" }))).toEqual({
      vendorClientId: "org:abc",
      name: "Organization abc",
    });
    expect(clientOf(device({ organizationName: "Only A Name" }))).toEqual({
      vendorClientId: "org-name:only a name",
      name: "Only A Name",
    });
    expect(clientOf(device({ name: "Lab unit" }))).toEqual({
      vendorClientId: "device:AA11",
      name: "Lab unit",
    });
    expect(clientOf(device({}))).toEqual({ vendorClientId: "device:AA11", name: "AA11" });
  });

  it("walks every page of the device list", async () => {
    const devices = Array.from({ length: 120 }, (_, i) => ({
      serialNumber: `SN${String(i).padStart(4, "0")}`,
      name: `unit-${i}`,
      clientCompanyName: `Client ${String(i % 30).padStart(2, "0")}`,
    }));
    const { api, connector } = connect({ devices, assets: {} });
    const clients = await connector.listClients();

    expect(clients).toHaveLength(30);
    const pages = api.calls.filter((c) => c.path === "bcdr/device").map((c) => c.query._page);
    expect(pages).toEqual(["1", "2", "3"]);
    expect(api.calls.every((c) => c.query._perPage === "50")).toBe(true);
  });

  it("returns no clients for an account with no devices", async () => {
    const { connector } = connect({ devices: [], assets: {} });
    expect(await connector.listClients()).toEqual([]);
    expect(await connector.listResults(new Date(0))).toEqual([]);
  });

  it("skips a device it cannot read instead of failing the sync, and says how many", async () => {
    const lines: string[] = [];
    const logger = createLogger({
      name: "datto-test",
      destination: new Writable({
        write(chunk: Buffer, _encoding, done) {
          lines.push(chunk.toString());
          done();
        },
      }),
    });
    const devices = [
      ...fixtureDevices,
      { name: "no serial" },
      { serialNumber: "", name: "empty serial" },
      { serialNumber: 12345, name: "numeric serial" },
      "not even an object",
      null,
    ];
    const { connector } = connect({ devices }, { logger });
    expect(await connector.listClients()).toHaveLength(3);
    expect(lines.join("")).toContain('"skipped":5');
  });

  it.each(["../../admin", "..", "A1/B2", "A1?x=1", "A1 B2", "A1%2F", ""])(
    "never puts an unsafe serial number %j into a request path",
    async (serialNumber) => {
      const { api, connector } = connect({
        devices: [{ serialNumber, clientCompanyName: "Odd" }],
        assets: {},
      });
      await connector.listClients();
      await connector.listResults(new Date(0));
      expect(api.calls.map((c) => c.path)).toEqual(["bcdr/device"]);
    },
  );
});

describe("datto connector: assets", () => {
  it("lists a client's assets across all of its appliances", async () => {
    const { connector } = connect();
    const assets = await connector.listAssets(HDG);
    expect(assets).toEqual([
      {
        vendorAssetId: "A1B2C3D4E5F6:9b1f0c2e-dc01",
        vendorClientId: HDG,
        name: "HDG-DC01",
        type: "agent",
        deviceName: "HDG-BDR01",
        isPaused: false,
        isArchived: false,
        expectedFrequencyHours: null,
      },
      expect.objectContaining({
        vendorAssetId: "A1B2C3D4E5F6:9b1f0c2e-fs01",
        name: "HDG-FS01",
        type: "agent",
      }),
      expect.objectContaining({
        vendorAssetId: "A1B2C3D4E5F6:9b1f0c2e-scans",
        name: "Scans",
        type: "share",
      }),
      expect.objectContaining({
        vendorAssetId: "0011223344AA:77aa-sql01",
        name: "HDG-SQL01",
        deviceName: "HDG-BDR02",
      }),
    ]);
  });

  it("carries the paused and archived flags", async () => {
    const { connector } = connect();
    const assets = await connector.listAssets(KFL);
    const flags = Object.fromEntries(assets.map((a) => [a.name, [a.isPaused, a.isArchived]]));
    expect(flags).toEqual({
      "KFL-APP01": [true, false],
      "KFL-OLD01": [false, true],
      "KFL-DB01": [false, false],
      "KFL-NEW01": [false, false],
    });
  });

  it("returns nothing for an appliance with no assets, or a client it does not know", async () => {
    const { connector } = connect();
    expect(await connector.listAssets(SPARE)).toEqual([]);
    expect(await connector.listAssets("company:nobody")).toEqual([]);
  });

  it("gives every asset an id that is unique across the account", async () => {
    // Two appliances protecting an asset with the same name and key.
    const twin = { name: "DC01", volume: "same-key", agentVersion: "1" };
    const { connector } = connect({
      devices: [
        { serialNumber: "AAAA1111", clientCompanyName: "Twin" },
        { serialNumber: "BBBB2222", clientCompanyName: "Twin" },
      ],
      assets: { AAAA1111: [twin], BBBB2222: [twin] },
    });
    const ids = (await connector.listAssets("company:twin")).map((a) => a.vendorAssetId);
    expect(ids).toEqual(["AAAA1111:same-key", "BBBB2222:same-key"]);
  });

  it("falls back to the asset name when Datto gives no key", async () => {
    const { connector } = connect({
      devices: [{ serialNumber: "AAAA1111", clientCompanyName: "X" }],
      assets: {
        AAAA1111: [
          { name: "FS01", os: "Windows" },
          { name: "Archive", volume: "  " },
        ],
      },
    });
    expect((await connector.listAssets("company:x")).map((a) => [a.vendorAssetId, a.type])).toEqual(
      [
        ["AAAA1111:FS01", "agent"],
        ["AAAA1111:Archive", "share"],
      ],
    );
  });

  it("accepts the asset list as a bare array or as a paged wrapper", async () => {
    const bare = await connect().connector.listAssets(HDG);
    const wrapped = await connect({ wrapAssets: true }).connector.listAssets(HDG);
    expect(wrapped).toEqual(bare);
  });

  it("walks every page of a long asset list", async () => {
    const many = Array.from({ length: 130 }, (_, i) => ({
      name: `VM-${i}`,
      volume: `v${i}`,
      os: "Linux",
    }));
    const { api, connector } = connect({
      devices: [{ serialNumber: "AAAA1111", clientCompanyName: "Big" }],
      assets: { AAAA1111: many },
      wrapAssets: true,
    });
    expect(await connector.listAssets("company:big")).toHaveLength(130);
    expect(api.calls.filter((c) => c.path.endsWith("/asset")).map((c) => c.query._page)).toEqual([
      "1",
      "2",
      "3",
    ]);
  });

  it("skips an asset it cannot read and keeps the rest", async () => {
    const { connector } = connect({
      devices: [{ serialNumber: "AAAA1111", clientCompanyName: "X" }],
      assets: { AAAA1111: [{ volume: "no-name" }, null, 7, { name: "Good", os: "Linux" }] },
    });
    expect((await connector.listAssets("company:x")).map((a) => a.name)).toEqual(["Good"]);
  });
});

describe("datto connector: results", () => {
  it("returns every backup since the given time, across all clients, oldest first", async () => {
    const { connector } = connect();
    const results = await connector.listResults(hoursBefore(30));

    expect(
      results.map((r) => [
        r.vendorAssetId,
        Math.round((FIXTURE_NOW.getTime() - r.startedAt.getTime()) / HOUR),
      ]),
    ).toEqual([
      ["A1B2C3D4E5F6:9b1f0c2e-fs01", 27],
      ["A1B2C3D4E5F6:9b1f0c2e-dc01", 26],
      ["A1B2C3D4E5F6:9b1f0c2e-scans", 5],
      ["0011223344AA:77aa-sql01", 4],
      ["A1B2C3D4E5F6:9b1f0c2e-fs01", 3],
      ["A1B2C3D4E5F6:9b1f0c2e-dc01", 2],
      ["FFEEDDCCBBAA:kfl-db01", 1],
    ]);
  });

  it("includes a backup exactly at the boundary and excludes one a second earlier", async () => {
    const { connector } = connect();
    const at = hoursBefore(26);
    expect(
      (await connector.listResults(at)).some((r) => r.startedAt.getTime() === at.getTime()),
    ).toBe(true);
    const later = new Date(at.getTime() + 1000);
    expect(
      (await connect().connector.listResults(later)).some(
        (r) => r.startedAt.getTime() === at.getTime(),
      ),
    ).toBe(false);
  });

  it("maps each backup to a result and normalizes it", async () => {
    const { connector } = connect();
    const results = await connector.listResults(new Date(0));
    const view = results.map((r) => ({
      asset: r.vendorAssetId.split(":")[1],
      raw: r.vendorStatusRaw,
      status: connector.normalizeStatus(r.rawPayload),
      screenshot: r.screenshotVerified,
      message: r.message,
    }));

    expect(view).toEqual([
      { asset: "kfl-app01", raw: "success", status: "success", screenshot: true, message: null },
      {
        asset: "9b1f0c2e-dc01",
        raw: "success",
        status: "success",
        screenshot: true,
        message: null,
      },
      {
        asset: "9b1f0c2e-fs01",
        raw: "success",
        status: "success",
        screenshot: true,
        message: null,
      },
      {
        asset: "9b1f0c2e-dc01",
        raw: "success",
        status: "warning",
        screenshot: false,
        message: "Screenshot verification failed.",
      },
      {
        asset: "9b1f0c2e-scans",
        raw: "success",
        status: "success",
        screenshot: null,
        message: null,
      },
      {
        asset: "77aa-sql01",
        raw: "success",
        status: "warning",
        screenshot: true,
        message: "Local verification: File system integrity check failed",
      },
      {
        asset: "9b1f0c2e-fs01",
        raw: "failure",
        status: "failed",
        screenshot: null,
        message: "Unable to take a VSS snapshot of volume D:",
      },
      {
        asset: "9b1f0c2e-dc01",
        raw: "success",
        status: "success",
        screenshot: true,
        message: null,
      },
      { asset: "kfl-db01", raw: "verifying", status: "unknown", screenshot: null, message: null },
    ]);
  });

  it("stores Datto's own record as the raw payload, untouched", async () => {
    const { connector } = connect();
    const results = await connector.listResults(new Date(0));
    const failed = results.find((r) => r.vendorStatusRaw === "failure")!;
    expect(failed.rawPayload).toEqual(
      (fixtureAssets.A1B2C3D4E5F6![1] as { backups: unknown[] }).backups[1],
    );
    // And never the asset or device around it, or anything from the request.
    expect(JSON.stringify(results)).not.toContain("fixture-secret-do-not-use");
    expect(JSON.stringify(results)).not.toContain("agentVersion");
  });

  it("gives each result an id that is stable between fetches", async () => {
    const first = await connect().connector.listResults(new Date(0));
    const second = await connect().connector.listResults(new Date(0));
    expect(second.map((r) => [r.vendorAssetId, r.vendorResultId])).toEqual(
      first.map((r) => [r.vendorAssetId, r.vendorResultId]),
    );
    const keys = first.map((r) => `${r.vendorAssetId}|${r.vendorResultId}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("stores a backup once when Datto lists it twice, and keeps same-time backups of different assets apart", async () => {
    const t = Math.floor(hoursBefore(1).getTime() / 1000);
    const backup = { timestamp: t, backup: { status: "success" } };
    const { connector } = connect({
      devices: [{ serialNumber: "AAAA1111", clientCompanyName: "X" }],
      assets: {
        AAAA1111: [
          { name: "One", volume: "one", backups: [backup, backup] },
          { name: "Two", volume: "two", backups: [backup] },
        ],
      },
    });
    const results = await connector.listResults(new Date(0));
    expect(results.map((r) => r.vendorAssetId).sort()).toEqual(["AAAA1111:one", "AAAA1111:two"]);
  });

  it("reads timestamps in seconds, milliseconds or ISO form, and treats the snapshot as instantaneous", async () => {
    const at = hoursBefore(1);
    const { connector } = connect({
      devices: [{ serialNumber: "AAAA1111", clientCompanyName: "X" }],
      assets: {
        AAAA1111: [
          {
            name: "S",
            volume: "s",
            backups: [{ timestamp: at.getTime() / 1000, backup: { status: "success" } }],
          },
          {
            name: "MS",
            volume: "ms",
            backups: [{ timestamp: at.getTime(), backup: { status: "success" } }],
          },
          {
            name: "ISO",
            volume: "iso",
            backups: [{ timestamp: at.toISOString(), backup: { status: "success" } }],
          },
        ],
      },
    });
    const results = await connector.listResults(new Date(0));
    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(result.startedAt).toEqual(at);
      expect(result.endedAt).toEqual(at);
    }
  });

  it("skips a backup entry it cannot read and keeps the rest", async () => {
    const good = {
      timestamp: Math.floor(hoursBefore(1).getTime() / 1000),
      backup: { status: "success" },
    };
    const { connector } = connect({
      devices: [{ serialNumber: "AAAA1111", clientCompanyName: "X" }],
      assets: {
        AAAA1111: [
          {
            name: "Mixed",
            volume: "mixed",
            backups: [
              { backup: { status: "success" } },
              { timestamp: "not a time" },
              null,
              "junk",
              good,
            ],
          },
        ],
      },
    });
    const results = await connector.listResults(new Date(0));
    expect(results).toHaveLength(1);
    expect(results[0]!.rawPayload).toEqual(good);
  });

  it("returns nothing for assets with no backups", async () => {
    const { connector } = connect();
    const results = await connector.listResults(new Date(0));
    for (const asset of ["kfl-old01", "kfl-new01"]) {
      expect(results.some((r) => r.vendorAssetId.endsWith(asset))).toBe(false);
    }
  });
});

describe("datto connector: requests", () => {
  it("fetches each appliance's assets once per sync, however the methods are called", async () => {
    const { api, connector } = connect();
    const clients = await connector.listClients();
    await Promise.all(clients.map((c) => connector.listAssets(c.vendorClientId)));
    await connector.listResults(new Date(0));
    await connector.listResults(hoursBefore(5));

    const paths = api.calls.map((c) => c.path);
    expect(paths.filter((p) => p === "bcdr/device")).toHaveLength(1);
    expect(paths.filter((p) => p.endsWith("/asset")).sort()).toEqual(
      fixtureDevices.map((d) => `bcdr/device/${String(d.serialNumber)}/asset`).sort(),
    );
  });

  it("only ever issues GET requests, to the two endpoints it needs", async () => {
    const { api, connector } = connect();
    await connector.testConnection();
    for (const client of await connector.listClients())
      await connector.listAssets(client.vendorClientId);
    await connector.listResults(new Date(0));

    expect(new Set(api.calls.map((c) => c.method))).toEqual(new Set(["GET"]));
    for (const call of api.calls) {
      expect(call.path).toMatch(/^bcdr\/device(\/[A-Za-z0-9]+\/asset)?$/);
    }
  });

  it("works end to end against an API that checks the keys", async () => {
    const { connector } = connect({ accept: credentials });
    expect(await connector.listClients()).toHaveLength(3);

    const wrong = new DattoConnector(
      { publicKey: "fixture-public-9f3a", secretKey: "fixture-wrong" },
      { fetch: fakeDatto({ accept: credentials }).fetch, ...noWait },
    );
    await expect(wrong.listClients()).rejects.toBeInstanceOf(AuthError);
  });

  it("skips an appliance that disappears mid-sync (404) and carries on", async () => {
    const { connector } = connect({
      override: (path) =>
        path === "bcdr/device/0011223344AA/asset"
          ? new Response("gone", { status: 404 })
          : undefined,
    });
    const assets = await connector.listAssets(HDG);
    expect(assets.map((a) => a.name)).toEqual(["HDG-DC01", "HDG-FS01", "Scans"]);
    expect((await connector.listResults(new Date(0))).length).toBeGreaterThan(0);
  });

  it("fails the whole sync when an appliance's assets cannot be fetched", async () => {
    // Carrying on would report a successful sync with stale data for that
    // appliance, and its assets would then look as if they had missed backups.
    const { connector } = connect(
      {
        override: (path) =>
          path === "bcdr/device/FFEEDDCCBBAA/asset"
            ? new Response("boom", { status: 500 })
            : undefined,
      },
      { maxRetries: 1 },
    );
    await expect(connector.listResults(new Date(0))).rejects.toBeInstanceOf(VendorError);
  });

  it("retries a transient failure part-way through and still returns everything", async () => {
    let failed = false;
    const { connector } = connect({
      override: (path) => {
        if (path === "bcdr/device/A1B2C3D4E5F6/asset" && !failed) {
          failed = true;
          return new Response("", { status: 503 });
        }
        return undefined;
      },
    });
    expect(await connector.listResults(new Date(0))).toHaveLength(9);
  });

  it("rejects a response that is not a list at all", async () => {
    for (const body of ['{"error":"maintenance"}', '"ok"', "42", "null"]) {
      const { connector } = connect({
        override: (path) =>
          path === "bcdr/device" ? new Response(body, { status: 200 }) : undefined,
      });
      await expect(connector.listClients()).rejects.toBeInstanceOf(InvalidResponseError);
    }
  });

  it("does not send more than two requests at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const devices = Array.from({ length: 12 }, (_, i) => ({
      serialNumber: `SN${i}`,
      clientCompanyName: "X",
    }));
    const assets = Object.fromEntries(devices.map((d) => [d.serialNumber, []]));
    const api = fakeDatto({ devices, assets });
    const slow = (async (...args: Parameters<typeof fetch>) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 3));
      inFlight -= 1;
      return api.fetch(...args);
    }) as typeof fetch;
    await new DattoConnector(credentials, { fetch: slow, ...noWait }).listResults(new Date(0));
    expect(api.calls).toHaveLength(13);
    expect(peak).toBe(2);
  });
});
