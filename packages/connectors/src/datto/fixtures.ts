/**
 * A stand-in for Datto's API, for tests.
 *
 * NOT captured from a live account. The payloads follow the shape assumed in
 * schema.ts, so tests built on them prove the connector is consistent with
 * that assumption, not that the assumption is right. When real responses are
 * available, replace these with trimmed, anonymized captures.
 */

/** The moment the fixture fleet is "seen" at. */
export const FIXTURE_NOW = new Date("2026-11-12T12:00:00Z");
const hoursAgo = (hours: number) => Math.floor(FIXTURE_NOW.getTime() / 1000) - hours * 3600;

const ok = { status: "success", errorMessage: null };
const verified = {
  localVerification: { status: "success", errors: [] },
  advancedVerification: {
    screenshotVerification: { status: "success", image: "https://device.example.test/shot-1.jpg" },
  },
};

export const fixtureDevices: Record<string, unknown>[] = [
  {
    serialNumber: "A1B2C3D4E5F6",
    name: "HDG-BDR01",
    model: "S4B2",
    hidden: false,
    clientCompanyName: "Harborview Dental Group",
    organizationId: 9001,
    organizationName: "Example MSP",
    agentCount: 2,
    shareCount: 1,
  },
  {
    // Same client, different capitalization, second appliance.
    serialNumber: "0011223344AA",
    name: "HDG-BDR02",
    clientCompanyName: "harborview dental group",
    organizationId: 9001,
    organizationName: "Example MSP",
  },
  {
    // No client name: falls back to the organization.
    serialNumber: "FFEEDDCCBBAA",
    name: "KFL-BDR01",
    clientCompanyName: "",
    organizationId: 4471,
    organizationName: "Kestrel Freight & Logistics",
  },
  {
    // Not assigned to anyone, and protecting nothing.
    serialNumber: "123456789ABC",
    name: "Spare unit",
  },
];

export const fixtureAssets: Record<string, unknown[]> = {
  A1B2C3D4E5F6: [
    {
      name: "HDG-DC01",
      volume: "9b1f0c2e-dc01",
      os: "Windows Server 2022",
      agentVersion: "3.0.18.7",
      isPaused: false,
      isArchived: false,
      lastSnapshot: hoursAgo(2),
      backups: [
        { timestamp: hoursAgo(50), backup: ok, ...verified },
        {
          timestamp: hoursAgo(26),
          backup: ok,
          localVerification: { status: "success", errors: [] },
          advancedVerification: { screenshotVerification: { status: "failure", image: null } },
        },
        { timestamp: hoursAgo(2), backup: ok, ...verified },
      ],
    },
    {
      name: "HDG-FS01",
      volume: "9b1f0c2e-fs01",
      os: "Windows Server 2019",
      agentVersion: "3.0.18.7",
      isPaused: false,
      isArchived: false,
      backups: [
        { timestamp: hoursAgo(27), backup: ok, ...verified },
        {
          timestamp: hoursAgo(3),
          backup: { status: "failure", errorMessage: "Unable to take a VSS snapshot of volume D:" },
          localVerification: null,
          advancedVerification: null,
        },
      ],
    },
    {
      // A share: nothing to boot, so no screenshot verification.
      name: "Scans",
      volume: "9b1f0c2e-scans",
      type: "share",
      isPaused: false,
      isArchived: false,
      backups: [{ timestamp: hoursAgo(5), backup: ok }],
    },
  ],
  "0011223344AA": [
    {
      name: "HDG-SQL01",
      volume: "77aa-sql01",
      os: "Windows Server 2022",
      agentVersion: "3.0.18.7",
      backups: [
        {
          timestamp: hoursAgo(4),
          backup: ok,
          localVerification: {
            status: "failure",
            errors: [
              { errorType: "filesystem", errorMessage: "File system integrity check failed" },
            ],
          },
          advancedVerification: { screenshotVerification: { status: "success" } },
        },
      ],
    },
  ],
  FFEEDDCCBBAA: [
    {
      name: "KFL-APP01",
      volume: "kfl-app01",
      os: "Ubuntu 24.04",
      agentVersion: "2.9.0",
      isPaused: true,
      isArchived: false,
      backups: [{ timestamp: hoursAgo(200), backup: ok, ...verified }],
    },
    {
      name: "KFL-OLD01",
      volume: "kfl-old01",
      os: "Windows Server 2012 R2",
      agentVersion: "2.1.0",
      isPaused: false,
      isArchived: true,
      backups: [],
    },
    {
      // A status string we have no mapping for.
      name: "KFL-DB01",
      volume: "kfl-db01",
      os: "Windows Server 2022",
      agentVersion: "3.0.18.7",
      backups: [{ timestamp: hoursAgo(1), backup: { status: "verifying" } }],
    },
    {
      // Protected, but Datto lists no backups for it at all.
      name: "KFL-NEW01",
      volume: "kfl-new01",
      os: "Windows 11",
      agentVersion: "3.0.18.7",
    },
  ],
  "123456789ABC": [],
};

export interface FakeDattoOptions {
  /** Devices to serve. Loosely typed so tests can include malformed entries. */
  devices?: unknown[];
  assets?: Record<string, unknown[]>;
  /** Return the asset list as `{ pagination, items }` instead of a bare array. */
  wrapAssets?: boolean;
  /** Only this key pair is accepted. Any other gets a 401. */
  accept?: { publicKey: string; secretKey: string };
  /** Replace the response for requests whose path matches. */
  override?: (path: string, call: number) => Response | undefined;
}

export interface FakeDatto {
  fetch: typeof fetch;
  /** Every request made, in order. */
  calls: { method: string | undefined; path: string; query: Record<string, string> }[];
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Serves the fixture fleet over a fake `fetch`, with real pagination. */
export function fakeDatto(options: FakeDattoOptions = {}): FakeDatto {
  const devices = options.devices ?? fixtureDevices;
  const assets = options.assets ?? fixtureAssets;
  const calls: FakeDatto["calls"] = [];

  const impl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/v1\//, "");
    const query = Object.fromEntries(url.searchParams);
    calls.push({ method: init?.method, path, query });

    if (options.accept) {
      const expected = `Basic ${Buffer.from(
        `${options.accept.publicKey}:${options.accept.secretKey}`,
      ).toString("base64")}`;
      const given = (init?.headers as Record<string, string> | undefined)?.authorization;
      if (given !== expected) return json({ message: "Unauthorized" }, 401);
    }

    const overridden = options.override?.(path, calls.length);
    if (overridden) return overridden;

    const page = Number(query._page ?? 1);
    const perPage = Number(query._perPage ?? 100);
    const paged = (all: unknown[]) => ({
      pagination: {
        page,
        perPage,
        totalPages: Math.max(1, Math.ceil(all.length / perPage)),
        count: all.length,
      },
      items: all.slice((page - 1) * perPage, page * perPage),
    });

    if (path === "bcdr/device") return json(paged(devices));

    const match = /^bcdr\/device\/([^/]+)\/asset$/.exec(path);
    if (match) {
      const list = assets[decodeURIComponent(match[1]!)];
      if (!list) return json({ message: "Not found" }, 404);
      return json(options.wrapAssets ? paged(list) : page === 1 ? list : []);
    }
    return json({ message: "Not found" }, 404);
  }) as typeof fetch;

  return { fetch: impl, calls };
}
