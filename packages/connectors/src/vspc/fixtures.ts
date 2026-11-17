/**
 * A stand-in Veeam Service Provider Console for tests and the demo, answering
 * the five collections the connector reads with records shaped as Veeam's
 * OpenAPI specification (REST API 3.5.1 / 3.6.1) describes them.
 *
 * It behaves as the specification says a console does: it requires the
 * bearer key and the `x-client-version` header, pages with `offset` and
 * `limit` (500 at most) and reports `meta.pagingInfo`, honours `select`, and
 * answers anything but GET with 405. Its companies carry an owner password,
 * as a real console's can, so tests can prove the connector never asks for it.
 */

export const FIXTURE_KEY = "fixture-vspc-api-key-0123456789abcdef";
export const PROVIDER_ORG = "00000000-0000-4000-8000-0000000000aa";
export const ACME = "11111111-1111-4111-8111-111111111111";
export const BIRCH = "22222222-2222-4222-8222-222222222222";
export const GONE_CO = "33333333-3333-4333-8333-333333333333";

const JOB_ACME_DAILY = "aaaaaaaa-0000-4000-8000-000000000001";
const JOB_ACME_WEEKLY = "aaaaaaaa-0000-4000-8000-000000000002";
const JOB_BIRCH_OFF = "aaaaaaaa-0000-4000-8000-000000000003";
const JOB_PROVIDER = "aaaaaaaa-0000-4000-8000-000000000004";

export const VM_SQL = "bbbbbbbb-0000-4000-8000-000000000001";
export const VM_FS = "bbbbbbbb-0000-4000-8000-000000000002";
export const VM_NEW = "bbbbbbbb-0000-4000-8000-000000000003";
export const VM_EXCLUDED = "bbbbbbbb-0000-4000-8000-000000000004";
export const VM_BIRCH = "bbbbbbbb-0000-4000-8000-000000000005";
export const VM_PROVIDER = "bbbbbbbb-0000-4000-8000-000000000006";

export const AGENT_LAPTOP = "cccccccc-0000-4000-8000-000000000001";
export const AGENT_SERVER = "cccccccc-0000-4000-8000-000000000002";

export interface VspcFixture {
  companies: Record<string, unknown>[];
  serverJobs: Record<string, unknown>[];
  vmObjects: Record<string, unknown>[];
  agents: Record<string, unknown>[];
  agentJobs: Record<string, unknown>[];
}

/** A console with two clients, a deleted one, and the provider's own job. */
export function vspcFixture(): VspcFixture {
  const company = (instanceUid: string, name: string, status: string) => ({
    instanceUid,
    name,
    status,
    resellerUid: null,
    subscriptionPlanUid: "dddddddd-0000-4000-8000-000000000001",
    isAlarmDetectEnabled: true,
    ownerCredentials: {
      userName: `${name} owner`,
      password: "company-owner-password-must-not-leak",
    },
  });
  const job = (overrides: Record<string, unknown>) => ({
    uniqueUid: `u-${String(overrides.instanceUid)}`,
    type: "BackupVm",
    status: "Success",
    isEnabled: true,
    scheduleType: "Daily",
    organizationUid: PROVIDER_ORG,
    mappedOrganizationUid: null,
    backupServerUid: "eeeeeeee-0000-4000-8000-000000000001",
    lastRun: "2026-11-12T01:00:00.0000000+00:00",
    ...overrides,
  });
  const vm = (
    jobUid: string,
    instanceUid: string,
    name: string,
    lastSession: Record<string, unknown> | null,
    extra: Record<string, unknown> = {},
  ) => ({
    jobUid,
    uniqueJobUid: `u-${jobUid}`,
    instanceUid,
    name,
    platform: "vSphere",
    hierarchyRef: `vm-${name.toLowerCase()}`,
    isExcluded: false,
    lastSession,
    ...extra,
  });
  const session = (status: string, start: string, end: string | null, messages: string[] = []) => ({
    backupStatus: status,
    totalBackedSize: 1_000_000,
    sourceSize: 50_000_000,
    startTime: start,
    endTime: end,
    duration: 600,
    messages,
  });

  return {
    companies: [
      company(ACME, "Acme Dental", "Active"),
      company(BIRCH, "Birch Law", "Active"),
      company(GONE_CO, "Gone Co", "Deleted"),
    ],
    serverJobs: [
      job({ instanceUid: JOB_ACME_DAILY, name: "Acme nightly", mappedOrganizationUid: ACME }),
      job({
        instanceUid: JOB_ACME_WEEKLY,
        name: "Acme weekly",
        mappedOrganizationUid: ACME,
        scheduleType: "Monthly",
      }),
      job({
        instanceUid: JOB_BIRCH_OFF,
        name: "Birch servers",
        organizationUid: BIRCH,
        isEnabled: false,
        scheduleType: "Periodically",
      }),
      job({ instanceUid: JOB_PROVIDER, name: "Provider infrastructure" }),
    ],
    vmObjects: [
      vm(
        JOB_ACME_DAILY,
        VM_SQL,
        "ACME-SQL01",
        session("Failed", "2026-11-12T01:00:05.1234567+00:00", "2026-11-12T01:20:00+00:00", [
          "Processing ACME-SQL01",
          "Error: Failed to create VM snapshot.\r\nSnapshot timed out.",
        ]),
      ),
      // The same VM in a second job: one asset, a result from each job.
      vm(
        JOB_ACME_WEEKLY,
        VM_SQL,
        "ACME-SQL01",
        session("Success", "2026-11-08T22:00:00+00:00", "2026-11-08T23:00:00+00:00"),
      ),
      vm(
        JOB_ACME_DAILY,
        VM_FS,
        "ACME-FS01",
        session("Warning", "2026-11-12T01:05:00+00:00", "2026-11-12T01:30:00+00:00", [
          "Changed block tracking is disabled.",
        ]),
      ),
      vm(
        JOB_ACME_DAILY,
        VM_NEW,
        "ACME-NEW01",
        session("Unknown", "0001-01-01T00:00:00", "0001-01-01T00:00:00"),
      ),
      vm(
        JOB_ACME_DAILY,
        VM_EXCLUDED,
        "ACME-OLD01",
        session("Success", "2026-11-12T01:00:00+00:00", "2026-11-12T01:10:00+00:00"),
        { isExcluded: true },
      ),
      vm(
        JOB_BIRCH_OFF,
        VM_BIRCH,
        "BIRCH-DC01",
        session("Running", "2026-11-12T11:30:00+00:00", null),
      ),
      vm(
        JOB_PROVIDER,
        VM_PROVIDER,
        "VSPC-01",
        session("Success", "2026-11-12T00:00:00+00:00", "2026-11-12T00:05:00+00:00"),
      ),
    ],
    agents: [
      {
        instanceUid: AGENT_LAPTOP,
        name: "BIRCH-LT-07",
        organizationUid: BIRCH,
        agentPlatform: "Windows",
        platform: "Physical",
        status: "Active",
        managementMode: "ManagedByConsole",
      },
      {
        instanceUid: AGENT_SERVER,
        name: "ACME-APP01",
        organizationUid: ACME,
        agentPlatform: "Linux",
        platform: "Virtual",
        status: "Active",
        managementMode: "ManagedByConsole",
      },
    ],
    agentJobs: [
      {
        instanceUid: "ffffffff-0000-4000-8000-000000000001",
        backupAgentUid: AGENT_LAPTOP,
        organizationUid: BIRCH,
        name: "Laptop backup",
        status: "Failed",
        lastRun: "2026-11-12T09:00:00+00:00",
        lastEndTime: "2026-11-12T09:02:00+00:00",
        failureMessage:
          "Unable to connect to the backup repository.\r\nThe network path was not found.",
        isEnabled: true,
        scheduleType: "Daily",
        systemType: "Windows",
      },
      {
        instanceUid: "ffffffff-0000-4000-8000-000000000002",
        backupAgentUid: AGENT_SERVER,
        organizationUid: ACME,
        name: "App server",
        status: "Success",
        lastRun: "2026-11-11T23:00:00+00:00",
        lastEndTime: "2026-11-11T23:40:00+00:00",
        failureMessage: "",
        isEnabled: true,
        scheduleType: "Periodically",
        systemType: "Linux",
      },
    ],
  };
}

const COLLECTIONS: Record<string, keyof VspcFixture> = {
  "organizations/companies": "companies",
  "infrastructure/backupServers/jobs": "serverJobs",
  "infrastructure/backupServers/jobs/backupVmJobs/objects": "vmObjects",
  "infrastructure/backupAgents": "agents",
  "infrastructure/backupAgents/jobs": "agentJobs",
};

export interface FakeVspc {
  fetch: typeof fetch;
  requests: { method: string; path: string; query: URLSearchParams; headers: Headers }[];
}

/**
 * A `fetch` that answers as a console at `base` would. Responses can be
 * replaced per path for tests of failures.
 */
export function fakeVspc(
  fixture: VspcFixture = vspcFixture(),
  options: {
    base?: string;
    key?: string;
    override?: (path: string, query: URLSearchParams) => Response | undefined;
  } = {},
): FakeVspc {
  const base = new URL(options.base ?? "https://vspc.example.com:1280/api/v3/");
  const key = options.key ?? FIXTURE_KEY;
  const requests: FakeVspc["requests"] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const path = url.pathname.slice(base.pathname.length);
    requests.push({ method, path, query: url.searchParams, headers });

    const overridden = options.override?.(path, url.searchParams);
    if (overridden) return overridden;
    if (method !== "GET")
      return json({ errors: [{ code: 405, message: "Method not allowed." }] }, 405);
    if (headers.get("authorization") !== `Bearer ${key}`) {
      return json({ errors: [{ type: "security", code: 401, message: "Unauthorized." }] }, 401);
    }
    if (!headers.get("x-client-version")) {
      return json({ errors: [{ code: 400, message: "x-client-version is required." }] }, 400);
    }
    const name = COLLECTIONS[path];
    if (!name) return json({ errors: [{ code: 404, message: `${path} not found.` }] }, 404);

    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);
    const select = url.searchParams.get("select");
    const keep = select
      ? (JSON.parse(select) as { propertyPath: string }[]).map((s) => s.propertyPath)
      : null;
    const all = fixture[name];
    const page = all
      .slice(offset, offset + limit)
      .map((item) =>
        keep ? Object.fromEntries(Object.entries(item).filter(([k]) => keep.includes(k))) : item,
      );
    return json({
      meta: { pagingInfo: { total: all.length, count: page.length, offset } },
      data: page,
    });
  }) as typeof fetch;

  return { fetch: fetchImpl, requests };
}
