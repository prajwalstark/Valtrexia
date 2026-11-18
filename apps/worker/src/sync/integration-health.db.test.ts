import { randomBytes, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import {
  AuthError,
  ConnectorUnavailableError,
  DestinationRefusedError,
  InvalidCredentialsShapeError,
  InvalidResponseError,
  MockConnector,
  NetworkError,
  RateLimitError,
  VendorError,
} from "@valtrexia/connectors";
import {
  createLogger,
  DecryptionError,
  KeyServiceUnavailableError,
  LocalKeyProvider,
  Secret,
  type KeyProvider,
} from "@valtrexia/core/server";
import { createDb, createIntegration, replaceIntegrationCredentials, type Db } from "@valtrexia/db";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { classifyFailure, syncIntegration, type SyncDeps } from "./sync-integration";

const urls = inject("databaseUrls");
const MINUTE = 60_000;
const T0 = new Date("2026-11-12T12:00:00Z");
const after = (ms: number) => new Date(T0.getTime() + ms);

let db: Db;
const keyProvider = new LocalKeyProvider(randomBytes(32).toString("base64"));
const logLines: string[] = [];
const logger = createLogger({
  name: "health-test",
  level: "debug",
  destination: new Writable({
    write(chunk: Buffer, _encoding, done) {
      logLines.push(chunk.toString());
      done();
    },
  }),
});
const logged = (message: string) =>
  logLines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.msg === message);

beforeAll(() => {
  db = createDb({ url: urls.app });
});
afterAll(async () => {
  await db.disconnect();
});
beforeEach(() => {
  logLines.length = 0;
});

function deps(now: Date, overrides: Partial<SyncDeps> = {}): SyncDeps {
  return { db, keyProvider, logger, allowMock: true, now: () => now, ...overrides };
}

async function newTenant(credentials: unknown = { seed: "demo" }) {
  const tenantId = await db.provisionTenant({
    clerkOrgId: `org_${randomUUID()}`,
    name: "Health test MSP",
  });
  const integration = await db.withTenant(tenantId, (context) =>
    createIntegration(context, keyProvider, {
      vendor: "mock",
      name: "Demo data",
      credentials: new Secret(credentials),
      actorUserId: null,
    }),
  );
  return { tenantId, integrationId: integration.id };
}

const outage: SyncDeps["connectorFactory"] = () =>
  new MockConnector({ seed: "demo", simulate: "outage" });
const rateLimited: SyncDeps["connectorFactory"] = () =>
  new MockConnector({ seed: "demo", simulate: "rate_limited" });

const health = (target: { tenantId: string; integrationId: string }) =>
  db.withTenant(target.tenantId, ({ tx }) =>
    tx.integration.findUniqueOrThrow({
      where: { id: target.integrationId },
      select: {
        syncStatus: true,
        lastSyncAt: true,
        lastSyncErrorKind: true,
        consecutiveFailures: true,
        failingSince: true,
      },
    }),
  );

/** Runs `count` failing syncs, 15 minutes apart, starting at `start`. */
async function failTimes(
  target: { tenantId: string; integrationId: string },
  count: number,
  start: Date,
  /** Null uses the real connector for the integration's own credentials. */
  factory: SyncDeps["connectorFactory"] | null = outage,
) {
  for (let i = 0; i < count; i += 1) {
    const now = new Date(start.getTime() + i * 15 * MINUTE);
    await expect(
      syncIntegration(deps(now, factory ? { connectorFactory: factory } : {}), target),
    ).rejects.toThrow();
  }
}

describe("sync failure tracking", () => {
  it("starts clean", async () => {
    const target = await newTenant();
    expect(await health(target)).toEqual({
      syncStatus: "never",
      lastSyncAt: null,
      lastSyncErrorKind: null,
      consecutiveFailures: 0,
      failingSince: null,
    });
  });

  it("records the first failure: one failure, when it began, and what kind", async () => {
    const target = await newTenant();
    await syncIntegration(deps(T0), target);
    await failTimes(target, 1, after(15 * MINUTE));

    expect(await health(target)).toEqual({
      syncStatus: "error",
      lastSyncAt: T0,
      lastSyncErrorKind: "network",
      consecutiveFailures: 1,
      failingSince: after(15 * MINUTE),
    });
  });

  it("counts failures in a row and keeps the time of the first", async () => {
    const target = await newTenant();
    await syncIntegration(deps(T0), target);
    await failTimes(target, 3, after(15 * MINUTE));

    expect(await health(target)).toMatchObject({
      consecutiveFailures: 3,
      failingSince: after(15 * MINUTE),
      lastSyncAt: T0,
    });
  });

  it("keeps the kind of the most recent failure", async () => {
    const target = await newTenant();
    await failTimes(target, 2, T0);
    await failTimes(target, 1, after(30 * MINUTE), rateLimited);

    expect(await health(target)).toMatchObject({
      consecutiveFailures: 3,
      failingSince: T0,
      lastSyncErrorKind: "rate_limited",
    });
  });

  it("a successful sync ends the run", async () => {
    const target = await newTenant();
    await failTimes(target, 5, T0);
    await syncIntegration(deps(after(90 * MINUTE)), target);

    expect(await health(target)).toEqual({
      syncStatus: "ok",
      lastSyncAt: after(90 * MINUTE),
      lastSyncErrorKind: null,
      consecutiveFailures: 0,
      failingSince: null,
    });

    // And a later failure starts a new run, not a continuation of the old one.
    await failTimes(target, 1, after(120 * MINUTE));
    expect(await health(target)).toMatchObject({
      consecutiveFailures: 1,
      failingSince: after(120 * MINUTE),
    });
  });

  it("replacing the credentials ends the run", async () => {
    const target = await newTenant({ seed: "demo", simulate: "auth_error" });
    await failTimes(target, 2, T0, null);
    expect(await health(target)).toMatchObject({
      consecutiveFailures: 2,
      lastSyncErrorKind: "auth",
    });

    await db.withTenant(target.tenantId, (context) =>
      replaceIntegrationCredentials(context, keyProvider, {
        id: target.integrationId,
        credentials: new Secret({ seed: "demo" }),
        actorUserId: null,
      }),
    );
    expect(await health(target)).toMatchObject({
      syncStatus: "never",
      lastSyncErrorKind: null,
      consecutiveFailures: 0,
      failingSince: null,
    });
  });

  it("the database refuses a failure count without a start time, or the reverse", async () => {
    const target = await newTenant();
    const set = (data: { consecutiveFailures: number; failingSince: Date | null }) =>
      db.withTenant(target.tenantId, ({ tx }) =>
        tx.integration.update({ where: { id: target.integrationId }, data }),
      );
    await expect(set({ consecutiveFailures: 2, failingSince: null })).rejects.toThrow();
    await expect(set({ consecutiveFailures: 0, failingSince: T0 })).rejects.toThrow();
    await expect(set({ consecutiveFailures: -1, failingSince: T0 })).rejects.toThrow();
  });
});

describe("sync failure kinds", () => {
  it("classifies every connector error, and anything else as our own fault", () => {
    expect(classifyFailure(new AuthError(401))).toBe("auth");
    expect(classifyFailure(new InvalidCredentialsShapeError())).toBe("credentials");
    expect(classifyFailure(new DecryptionError())).toBe("credentials");
    expect(classifyFailure(new RateLimitError(1000))).toBe("rate_limited");
    expect(classifyFailure(new NetworkError(false))).toBe("network");
    expect(classifyFailure(new VendorError(503))).toBe("vendor");
    expect(classifyFailure(new InvalidResponseError("no items"))).toBe("invalid_response");
    expect(classifyFailure(new ConnectorUnavailableError("off"))).toBe("unavailable");
    expect(classifyFailure(new DestinationRefusedError("Private address."))).toBe("credentials");
    // An outage of the key service is ours to fix, and passes: not the tenant's credentials.
    expect(classifyFailure(new KeyServiceUnavailableError())).toBe("internal");
    expect(classifyFailure(new Error("anything"))).toBe("internal");
    expect(classifyFailure("a string")).toBe("internal");
  });

  it("stores the kind for a rejected key, unreadable credentials and a switched-off vendor", async () => {
    const rejected = await newTenant({ seed: "demo", simulate: "auth_error" });
    await failTimes(rejected, 1, T0, null);
    expect((await health(rejected)).lastSyncErrorKind).toBe("auth");

    const unreadable = await newTenant();
    const otherKey = new LocalKeyProvider(randomBytes(32).toString("base64"));
    await expect(
      syncIntegration(deps(T0, { keyProvider: otherKey }), unreadable),
    ).rejects.toThrow();
    expect((await health(unreadable)).lastSyncErrorKind).toBe("credentials");

    const switchedOff = await newTenant();
    await expect(syncIntegration(deps(T0, { allowMock: false }), switchedOff)).rejects.toThrow();
    expect((await health(switchedOff)).lastSyncErrorKind).toBe("unavailable");
  });
});

describe("sync failures caused by the key service", () => {
  it("records an outage as retrying, says what happened, and never asks for new credentials", async () => {
    const target = await newTenant();
    const down: KeyProvider = {
      wrapKey: (key, aad) => keyProvider.wrapKey(key, aad),
      unwrapKey: () => Promise.reject(new KeyServiceUnavailableError()),
      canUnwrap: (keyId) => keyProvider.canUnwrap(keyId),
    };
    await expect(syncIntegration(deps(T0, { keyProvider: down }), target)).rejects.toThrow();
    expect(await health(target)).toMatchObject({
      lastSyncErrorKind: "internal",
      consecutiveFailures: 1,
    });
    const { lastSyncError } = await db.withTenant(target.tenantId, ({ tx }) =>
      tx.integration.findUniqueOrThrow({ where: { id: target.integrationId } }),
    );
    expect(lastSyncError).toBe(
      "The encryption key service could not be reached. The next sync tries again.",
    );
    // Once it answers again, the next sync succeeds with the same stored credentials.
    await syncIntegration(deps(after(15 * MINUTE)), target);
    expect(await health(target)).toMatchObject({ lastSyncErrorKind: null, consecutiveFailures: 0 });
  });
});

describe("sync health in the log", () => {
  it("says an integration is unhealthy once, at the fourth failure in a row", async () => {
    const target = await newTenant();
    await syncIntegration(deps(T0), target);

    await failTimes(target, 3, after(15 * MINUTE));
    expect(logged("integration is unhealthy")).toHaveLength(0);

    await failTimes(target, 1, after(60 * MINUTE));
    expect(logged("integration is unhealthy")).toHaveLength(1);
    expect(logged("integration is unhealthy")[0]).toMatchObject({
      level: "warn",
      integrationId: target.integrationId,
      kind: "network",
      failures: 4,
    });

    await failTimes(target, 3, after(75 * MINUTE));
    expect(logged("integration is unhealthy")).toHaveLength(1);
  });

  it("says so at the first failure when the key is rejected", async () => {
    const target = await newTenant({ seed: "demo", simulate: "auth_error" });
    await failTimes(target, 2, T0, null);
    expect(logged("integration is unhealthy")).toHaveLength(1);
    expect(logged("integration is unhealthy")[0]).toMatchObject({ kind: "auth", failures: 1 });
  });

  it("says when it recovers, and how long the run was", async () => {
    const target = await newTenant();
    await failTimes(target, 2, T0);
    expect(logged("integration recovered")).toHaveLength(0);

    await syncIntegration(deps(after(30 * MINUTE)), target);
    expect(logged("integration recovered")).toHaveLength(1);
    expect(logged("integration recovered")[0]).toMatchObject({
      failures: 2,
      failingSince: T0.toISOString(),
    });

    await syncIntegration(deps(after(45 * MINUTE)), target);
    expect(logged("integration recovered")).toHaveLength(1);
  });
});
