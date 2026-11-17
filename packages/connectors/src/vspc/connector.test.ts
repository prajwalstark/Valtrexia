import { describe, expect, it } from "vitest";
import { AuthError, InvalidResponseError, VendorError } from "../errors";
import { VSPC_CLIENT_VERSION } from "./client";
import { VspcConnector } from "./connector";
import { normalizeServerUrl, vspcCredentialHint, vspcCredentialsSchema } from "./credentials";
import {
  ACME,
  AGENT_LAPTOP,
  AGENT_SERVER,
  BIRCH,
  fakeVspc,
  FIXTURE_KEY,
  VM_BIRCH,
  VM_EXCLUDED,
  VM_FS,
  VM_NEW,
  VM_PROVIDER,
  VM_SQL,
  vspcFixture,
} from "./fixtures";
import { normalizeVspcStatus, sessionMessage } from "./normalize";
import { parseVspcTimestamp } from "./schema";

const credentials = { serverUrl: "https://vspc.example.com:1280", apiKey: FIXTURE_KEY };
const quick = { sleep: async () => {}, random: () => 0, maxRetries: 1 };
const connectorFor = (fake = fakeVspc()) => ({
  fake,
  connector: new VspcConnector(credentials, { fetch: fake.fetch, ...quick }),
});

describe("vspc connector: clients", () => {
  it("lists companies by name, leaving out deleted ones", async () => {
    const { connector } = connectorFor();
    expect(await connector.listClients()).toEqual([
      { vendorClientId: ACME, name: "Acme Dental" },
      { vendorClientId: BIRCH, name: "Birch Law" },
    ]);
  });

  it("asks only for the fields it uses, so an owner's password is never fetched", async () => {
    const { connector, fake } = connectorFor();
    await connector.listClients();
    const request = fake.requests.find((r) => r.path === "organizations/companies")!;
    expect(JSON.parse(request.query.get("select")!)).toEqual([
      { propertyPath: "instanceUid" },
      { propertyPath: "name" },
      { propertyPath: "status" },
    ]);
    for (const r of fake.requests) expect(r.query.get("select"), r.path).not.toBeNull();
  });
});

describe("vspc connector: assets", () => {
  it("lists a client's VMs and agent computers, one asset per machine", async () => {
    const { connector } = connectorFor();
    const assets = await connector.listAssets(ACME);
    expect(assets.map((a) => [a.vendorAssetId, a.name, a.type]).sort()).toEqual(
      [
        [`agent:${AGENT_SERVER}`, "ACME-APP01", "agent"],
        [`vm:${VM_FS}`, "ACME-FS01", "vm"],
        [`vm:${VM_NEW}`, "ACME-NEW01", "vm"],
        // In two jobs, listed once.
        [`vm:${VM_SQL}`, "ACME-SQL01", "vm"],
      ].sort(),
    );
    expect(assets.every((a) => a.vendorClientId === ACME && !a.isArchived)).toBe(true);
  });

  it("leaves out VMs excluded from their job, and the provider's own jobs", async () => {
    const { connector } = connectorFor();
    const all = [...(await connector.listAssets(ACME)), ...(await connector.listAssets(BIRCH))];
    const ids = all.map((a) => a.vendorAssetId);
    expect(ids).not.toContain(`vm:${VM_EXCLUDED}`);
    expect(ids).not.toContain(`vm:${VM_PROVIDER}`);
  });

  it("assigns a job to the client it is mapped to, or else to the one owning its server", async () => {
    const { connector } = connectorFor();
    expect((await connector.listAssets(BIRCH)).map((a) => a.vendorAssetId).sort()).toEqual(
      [`agent:${AGENT_LAPTOP}`, `vm:${VM_BIRCH}`].sort(),
    );
  });

  it("takes a daily schedule as 24 hours, the shortest where a machine has several jobs", async () => {
    const { connector } = connectorFor();
    const acme = Object.fromEntries((await connector.listAssets(ACME)).map((a) => [a.name, a]));
    // Daily and monthly jobs: daily wins.
    expect(acme["ACME-SQL01"]!.expectedFrequencyHours).toBe(24);
    // Periodically: the interval is not available from every console version.
    expect(acme["ACME-APP01"]!.expectedFrequencyHours).toBeNull();
  });

  it("counts a machine as paused when every job protecting it is disabled", async () => {
    const { connector } = connectorFor();
    const birch = Object.fromEntries((await connector.listAssets(BIRCH)).map((a) => [a.name, a]));
    expect(birch["BIRCH-DC01"]!.isPaused).toBe(true);
    expect(birch["BIRCH-LT-07"]!.isPaused).toBe(false);
    expect((await connector.listAssets(ACME)).every((a) => !a.isPaused)).toBe(true);
  });

  it("does not count a machine as paused while any job protecting it is still on", async () => {
    const fixture = vspcFixture();
    const weekly = fixture.serverJobs.find((j) => j.name === "Acme weekly")!;
    weekly.isEnabled = false;
    const sql = (await connectorFor(fakeVspc(fixture)).connector.listAssets(ACME)).find(
      (a) => a.name === "ACME-SQL01",
    )!;
    expect(sql.isPaused).toBe(false);
  });

  it("names the job as the 'device' for a VM, and lists nothing for an unknown client", async () => {
    const { connector } = connectorFor();
    const fs = (await connector.listAssets(ACME)).find((a) => a.name === "ACME-FS01")!;
    expect(fs.deviceName).toBe("Acme nightly");
    expect(await connector.listAssets("00000000-0000-4000-8000-00000000ffff")).toEqual([]);
  });
});

describe("vspc connector: results", () => {
  const since = new Date("2026-11-01T00:00:00Z");

  it("reports each job's latest session for each machine, with its status and message", async () => {
    const { connector } = connectorFor();
    const results = await connector.listResults(since);
    const byKey = Object.fromEntries(
      results.map((r) => [`${r.vendorAssetId}@${r.startedAt.toISOString()}`, r]),
    );
    expect(Object.keys(byKey).sort()).toEqual(
      [
        `vm:${VM_SQL}@2026-11-12T01:00:05.123Z`,
        `vm:${VM_SQL}@2026-11-08T22:00:00.000Z`,
        `vm:${VM_FS}@2026-11-12T01:05:00.000Z`,
        `vm:${VM_BIRCH}@2026-11-12T11:30:00.000Z`,
        `vm:${VM_EXCLUDED}@2026-11-12T01:00:00.000Z`,
        `vm:${VM_PROVIDER}@2026-11-12T00:00:00.000Z`,
        `agent:${AGENT_LAPTOP}@2026-11-12T09:00:00.000Z`,
        `agent:${AGENT_SERVER}@2026-11-11T23:00:00.000Z`,
      ].sort(),
    );
    const sql = byKey[`vm:${VM_SQL}@2026-11-12T01:00:05.123Z`]!;
    expect(sql).toMatchObject({
      endedAt: new Date("2026-11-12T01:20:00Z"),
      vendorStatusRaw: "Failed",
      message: "Processing ACME-SQL01 Error: Failed to create VM snapshot. Snapshot timed out.",
      screenshotVerified: null,
    });
    expect(connector.normalizeStatus(sql.rawPayload)).toBe("failed");

    const running = byKey[`vm:${VM_BIRCH}@2026-11-12T11:30:00.000Z`]!;
    expect(running.endedAt).toBeNull();
    expect(connector.normalizeStatus(running.rawPayload)).toBe("running");

    const laptop = byKey[`agent:${AGENT_LAPTOP}@2026-11-12T09:00:00.000Z`]!;
    expect(laptop).toMatchObject({
      vendorStatusRaw: "Failed",
      message: "Unable to connect to the backup repository. The network path was not found.",
    });
    expect(connector.normalizeStatus(laptop.rawPayload)).toBe("failed");
    expect(byKey[`agent:${AGENT_SERVER}@2026-11-11T23:00:00.000Z`]!.message).toBeNull();
  });

  it("gives a running session no end time, even when the console reports an old one", async () => {
    const fixture = vspcFixture();
    const dc = fixture.vmObjects.find((o) => o.name === "BIRCH-DC01") as {
      lastSession: Record<string, unknown>;
    };
    dc.lastSession.endTime = "2026-11-11T11:45:00+00:00";
    const results = await connectorFor(fakeVspc(fixture)).connector.listResults(since);
    expect(results.find((r) => r.vendorAssetId === `vm:${VM_BIRCH}`)!.endedAt).toBeNull();

    const agentFixture = vspcFixture();
    agentFixture.agentJobs[0]!.status = "Running";
    const agents = await connectorFor(fakeVspc(agentFixture)).connector.listResults(since);
    expect(agents.find((r) => r.vendorAssetId === `agent:${AGENT_LAPTOP}`)!.endedAt).toBeNull();
  });

  it("skips a session that never ran, and one that started before `since`", async () => {
    const { connector } = connectorFor();
    const ids = (await connector.listResults(new Date("2026-11-10T00:00:00Z"))).map(
      (r) => r.vendorAssetId + r.startedAt.toISOString(),
    );
    expect(ids.some((id) => id.startsWith(`vm:${VM_NEW}`))).toBe(false);
    expect(ids).not.toContain(`vm:${VM_SQL}2026-11-08T22:00:00.000Z`);
  });

  it("gives a session the same id on every sync, and a new session a new id", async () => {
    const first = await connectorFor().connector.listResults(since);
    const again = await connectorFor().connector.listResults(since);
    expect(again.map((r) => r.vendorResultId).sort()).toEqual(
      first.map((r) => r.vendorResultId).sort(),
    );

    const fixture = vspcFixture();
    const sql = fixture.vmObjects[0] as { lastSession: { startTime: string } };
    sql.lastSession.startTime = "2026-11-13T01:00:00+00:00";
    const next = await connectorFor(fakeVspc(fixture)).connector.listResults(since);
    const ids = new Set(first.map((r) => r.vendorResultId));
    expect(next.filter((r) => !ids.has(r.vendorResultId))).toHaveLength(1);
  });

  it("keeps the record as received, as the raw payload", async () => {
    const results = await connectorFor().connector.listResults(since);
    const sql = results.find(
      (r) => r.vendorStatusRaw === "Failed" && r.vendorAssetId.startsWith("vm:"),
    )!;
    expect(sql.rawPayload).toMatchObject({
      jobUid: expect.any(String) as string,
      platform: "vSphere",
    });
  });
});

describe("vspc connector: the wire", () => {
  it("sends the key as a bearer token with the client version, and only GETs", async () => {
    const { connector, fake } = connectorFor();
    await connector.listResults(new Date(0));
    expect(fake.requests.length).toBeGreaterThan(0);
    for (const request of fake.requests) {
      expect(request.method).toBe("GET");
      expect(request.headers.get("authorization")).toBe(`Bearer ${FIXTURE_KEY}`);
      expect(request.headers.get("x-client-version")).toBe(VSPC_CLIENT_VERSION);
    }
  });

  it("fetches each collection once per sync, however many clients there are", async () => {
    const { connector, fake } = connectorFor();
    for (const client of await connector.listClients())
      await connector.listAssets(client.vendorClientId);
    await connector.listResults(new Date(0));
    const paths = fake.requests.map((r) => r.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toHaveLength(5);
  });

  it("pages with offset and limit until the reported total", async () => {
    const fixture = vspcFixture();
    const base = fixture.vmObjects[2]!;
    fixture.vmObjects = Array.from({ length: 1203 }, (_, i) => ({
      ...base,
      instanceUid: `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, "0")}`,
      name: `VM-${i}`,
    }));
    const { connector, fake } = connectorFor(fakeVspc(fixture));
    expect(await connector.listAssets(ACME)).toHaveLength(1203 + 1);
    const pages = fake.requests.filter((r) => r.path.endsWith("objects"));
    expect(pages.map((r) => [r.query.get("offset"), r.query.get("limit")])).toEqual([
      ["0", "500"],
      ["500", "500"],
      ["1000", "500"],
    ]);
  });

  it("tests a connection with a single company", async () => {
    const { connector, fake } = connectorFor();
    await connector.testConnection();
    expect(fake.requests.map((r) => [r.path, r.query.get("limit")])).toEqual([
      ["organizations/companies", "1"],
    ]);
  });

  it("reports a rejected key as an authentication failure", async () => {
    const fake = fakeVspc(vspcFixture(), { key: "a-different-key-entirely-0000" });
    await expect(connectorFor(fake).connector.testConnection()).rejects.toBeInstanceOf(AuthError);
  });

  it("treats VSPC's 520 for server errors as a vendor error, after retrying", async () => {
    let calls = 0;
    const fake = fakeVspc(vspcFixture(), {
      override: () => {
        calls += 1;
        return new Response(JSON.stringify({ errors: [{ code: 500 }] }), { status: 520 });
      },
    });
    await expect(connectorFor(fake).connector.testConnection()).rejects.toBeInstanceOf(VendorError);
    expect(calls).toBe(2);
  });

  it("refuses a response that is not a collection", async () => {
    const fake = fakeVspc(vspcFixture(), {
      override: (path) =>
        path === "infrastructure/backupAgents" ? Response.json({ items: [] }) : undefined,
    });
    await expect(connectorFor(fake).connector.listClients()).rejects.toBeInstanceOf(
      InvalidResponseError,
    );
  });

  it("skips an unreadable item instead of failing the sync", async () => {
    const fixture = vspcFixture();
    fixture.vmObjects.push({ name: "missing ids" });
    const assets = await connectorFor(fakeVspc(fixture)).connector.listAssets(ACME);
    expect(assets.map((a) => a.name)).not.toContain("missing ids");
    expect(assets).toHaveLength(4);
  });
});

describe("vspc credentials", () => {
  it.each([
    ["https://vspc.example.com:1280", "https://vspc.example.com:1280"],
    ["  https://vspc.example.com:1280/  ", "https://vspc.example.com:1280"],
    ["https://vspc.example.com:1280/api/v3", "https://vspc.example.com:1280"],
    ["https://vspc.example.com:1280/api/v3/", "https://vspc.example.com:1280"],
    ["https://msp.example.com/vspc", "https://msp.example.com/vspc"],
    ["https://VSPC.Example.com", "https://vspc.example.com"],
  ])("reads %j as %j", (input, output) => {
    expect(normalizeServerUrl(input)).toBe(output);
  });

  it.each([
    "http://vspc.example.com:1280",
    "vspc.example.com:1280",
    "https://admin:pw@vspc.example.com:1280",
    "https://vspc.example.com:1280/?x=1",
    "https://vspc.example.com:1280/#top",
    "not a url",
    "",
  ])("refuses %j", (input) => {
    expect(normalizeServerUrl(input)).toBeNull();
  });

  it("validates a key and gives a hint naming the host and the key's last four characters", () => {
    const parsed = vspcCredentialsSchema.parse({
      serverUrl: "https://vspc.example.com:1280/api/v3",
      apiKey: ` ${FIXTURE_KEY} `,
    });
    expect(parsed).toEqual({ serverUrl: "https://vspc.example.com:1280", apiKey: FIXTURE_KEY });
    expect(vspcCredentialHint(parsed)).toBe("vspc.example.com:1280, key ending cdef");
    for (const apiKey of ["short", "has a space in it 0123456789", "x".repeat(1025)]) {
      expect(
        vspcCredentialsSchema.safeParse({ serverUrl: "https://v.example.com", apiKey }).success,
      ).toBe(false);
    }
    expect(vspcCredentialsSchema.safeParse({ ...credentials, extra: "field" }).success).toBe(false);
  });
});

describe("vspc normalization", () => {
  it("maps every VM session status in the specification", () => {
    const vm = (backupStatus: unknown) => ({ lastSession: { backupStatus } });
    expect(
      ["Success", "Warning", "Failed", "Running", "Unknown"].map((s) => normalizeVspcStatus(vm(s))),
    ).toEqual(["success", "warning", "failed", "running", "unknown"]);
  });

  it("maps every agent job status in the specification", () => {
    const statuses = [
      "Unknown",
      "None",
      "Success",
      "Warning",
      "Failed",
      "Starting",
      "Running",
      "Stopping",
    ];
    expect(statuses.map((status) => normalizeVspcStatus({ status }))).toEqual([
      "unknown",
      "unknown",
      "success",
      "warning",
      "failed",
      "running",
      "running",
      "running",
    ]);
  });

  it("calls anything it does not know unknown, and never throws", () => {
    for (const raw of [
      null,
      undefined,
      1,
      "Success",
      [],
      {},
      { status: "Exploded" },
      { lastSession: { backupStatus: "Brand new" } },
      { lastSession: null, status: 7 },
    ]) {
      expect(normalizeVspcStatus(raw)).toBe("unknown");
    }
  });

  it("reads timestamps with an offset, without one as UTC, and .NET's 'never' as nothing", () => {
    expect(parseVspcTimestamp("2026-11-12T01:00:05.1234567+00:00")).toEqual(
      new Date("2026-11-12T01:00:05.123Z"),
    );
    expect(parseVspcTimestamp("2026-11-12T03:00:00+02:00")).toEqual(
      new Date("2026-11-12T01:00:00Z"),
    );
    expect(parseVspcTimestamp("2026-11-12T01:00:00")).toEqual(new Date("2026-11-12T01:00:00Z"));
    for (const never of [
      "0001-01-01T00:00:00",
      "0001-01-01T00:00:00+00:00",
      "",
      null,
      undefined,
      "soon",
    ]) {
      expect(parseVspcTimestamp(never)).toBeNull();
    }
  });

  it("puts session messages on one line, and keeps them short", () => {
    expect(sessionMessage(["  First\r\nline ", "", "second"])).toBe("First line second");
    expect(sessionMessage([])).toBeNull();
    expect(sessionMessage(["x".repeat(900)])).toHaveLength(500);
  });
});
