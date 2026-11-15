import { randomBytes, randomUUID } from "node:crypto";
import { createLogger, LocalKeyProvider, Secret } from "@valtrexia/core/server";
import { createDb, createIntegration, replaceIntegrationCredentials, type Db } from "@valtrexia/db";
import { Queue } from "bullmq";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import {
  parseSyncJob,
  redisConnection,
  SCHEDULER_QUEUE,
  SYNC_QUEUE,
  syncJobId,
  TICK_SCHEDULER_ID,
} from "./queues";
import { enqueueDueSyncs } from "./scheduler";
import { startWorker, type RunningWorker, type WorkerOptions } from "./worker";

// The scheduler and worker against a real Redis and a real Postgres.

const urls = inject("databaseUrls");
const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const keyProvider = new LocalKeyProvider(randomBytes(32).toString("base64"));
const logger = createLogger({ name: "worker-test", level: "silent" });

let db: Db;
let owner: pg.Pool;
let prefix: string;
let queue: Queue;
const running: RunningWorker[] = [];

beforeAll(async () => {
  db = createDb({ url: urls.app });
  owner = new pg.Pool({ connectionString: urls.owner, max: 1 });

  const probe = new Queue("probe", {
    connection: redisConnection(redisUrl),
    prefix: `probe-${randomUUID()}`,
  });
  try {
    await Promise.race([
      probe.waitUntilReady(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
    ]);
  } catch (cause) {
    throw new Error(
      `Could not reach Redis at ${new URL(redisUrl).host} for the worker tests. Is it running (pnpm infra:up)?`,
      { cause },
    );
  } finally {
    await probe.close().catch(() => undefined);
  }
});

afterAll(async () => {
  await db.disconnect();
  await owner.end();
});

beforeEach(async () => {
  // Other test files leave integrations behind in the shared test database,
  // and all of them look due. Mark them as just synced so each test here
  // sees only the integrations it creates.
  await owner.query("UPDATE integrations SET last_sync_started_at = now()");
  prefix = `test-${randomUUID()}`;
  queue = new Queue(SYNC_QUEUE, { connection: redisConnection(redisUrl), prefix });
});

afterEach(async () => {
  for (const worker of running.splice(0)) await worker.close();
  await queue.obliterate({ force: true });
  await queue.close();
  const scheduler = new Queue(SCHEDULER_QUEUE, { connection: redisConnection(redisUrl), prefix });
  await scheduler.obliterate({ force: true });
  await scheduler.close();
});

async function integration(credentials: unknown = { seed: "demo" }) {
  const tenantId = await db.provisionTenant({
    clerkOrgId: `org_${randomUUID()}`,
    name: "Worker test",
  });
  const row = await db.withTenant(tenantId, (context) =>
    createIntegration(context, keyProvider, {
      vendor: "mock",
      name: "Demo data",
      credentials: new Secret(credentials),
      actorUserId: null,
    }),
  );
  return { tenantId, integrationId: row.id };
}

const stateOf = (target: { tenantId: string; integrationId: string }) =>
  db.withTenant(target.tenantId, async ({ tx }) => ({
    integration: await tx.integration.findUnique({ where: { id: target.integrationId } }),
    assets: await tx.asset.count(),
    results: await tx.backupResult.count(),
    incidents: await tx.incident.count(),
  }));

async function until<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for the worker");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function start(overrides: Partial<WorkerOptions> = {}): Promise<RunningWorker> {
  const worker = await startWorker({
    db,
    keyProvider,
    logger,
    redisUrl,
    allowMock: true,
    syncIntervalMinutes: 15,
    syncConcurrency: 3,
    // One tick runs at startup. After that, tests trigger ticks themselves
    // unless they shorten this.
    schedulerTickSeconds: 3600,
    prefix,
    ...overrides,
  });
  running.push(worker);
  return worker;
}

describe("scheduler tick", () => {
  it("queues one sync job per due integration, carrying only ids", async () => {
    const one = await integration();
    const two = await integration();
    const result = await enqueueDueSyncs({ db, queue, intervalMinutes: 15, logger });

    expect(result).toEqual({ due: 2, enqueued: 2 });
    const jobs = await queue.getJobs(["waiting"]);
    expect(jobs.map((job) => job.id).sort()).toEqual(
      [one, two].map((t) => syncJobId(t.integrationId)).sort(),
    );
    for (const job of jobs) {
      expect(Object.keys(job.data as object).sort()).toEqual(["integrationId", "tenantId"]);
      expect(() => parseSyncJob(job.data)).not.toThrow();
      expect(job.opts).toMatchObject({ attempts: 1, removeOnComplete: true, removeOnFail: true });
    }
    expect(jobs.map((job) => (job.data as { tenantId: string }).tenantId).sort()).toEqual(
      [one.tenantId, two.tenantId].sort(),
    );
  });

  it("does not queue an integration twice while its job is still waiting", async () => {
    await integration();
    await enqueueDueSyncs({ db, queue, intervalMinutes: 15, logger });
    const again = await enqueueDueSyncs({ db, queue, intervalMinutes: 15, logger });
    expect(again).toEqual({ due: 1, enqueued: 0 });
    expect(await queue.getJobCounts("waiting")).toMatchObject({ waiting: 1 });
  });

  it("skips integrations whose sync started within the interval, and picks them up after it", async () => {
    const target = await integration();
    const startedMinutesAgo = (minutes: number) =>
      owner.query(
        "UPDATE integrations SET last_sync_started_at = now() - make_interval(mins => $2) WHERE id = $1",
        [target.integrationId, minutes],
      );

    await startedMinutesAgo(5);
    expect(await enqueueDueSyncs({ db, queue, intervalMinutes: 15, logger })).toEqual({
      due: 0,
      enqueued: 0,
    });

    await startedMinutesAgo(16);
    expect(await enqueueDueSyncs({ db, queue, intervalMinutes: 15, logger })).toEqual({
      due: 1,
      enqueued: 1,
    });
  });

  it("does nothing when nothing is due", async () => {
    expect(await enqueueDueSyncs({ db, queue, intervalMinutes: 15, logger })).toEqual({
      due: 0,
      enqueued: 0,
    });
    expect(await queue.getJobCounts("waiting")).toMatchObject({ waiting: 0 });
  });

  it("refuses job data that is not exactly two ids", () => {
    const ok = { tenantId: randomUUID(), integrationId: randomUUID() };
    expect(parseSyncJob(ok)).toEqual(ok);
    for (const bad of [
      null,
      {},
      { tenantId: ok.tenantId },
      { ...ok, tenantId: "not-a-uuid" },
      { ...ok, credentials: "x" },
      { ...ok, vendor: "mock" },
    ]) {
      expect(() => parseSyncJob(bad)).toThrow();
    }
  });
});

describe("worker", () => {
  it("syncs a due integration as soon as it starts: tick, job, vendor, database, incidents", async () => {
    const target = await integration();
    // The first tick runs at startup, so nothing here has to ask for it.
    const worker = await start();

    const state = await until(
      () => stateOf(target),
      (s) => s.integration?.syncStatus === "ok",
    );
    expect(state.integration).toMatchObject({ syncStatus: "ok", lastSyncError: null });
    expect(state.integration!.lastSyncAt).not.toBeNull();
    expect(state.assets).toBeGreaterThan(30);
    expect(state.results).toBeGreaterThan(500);
    expect(state.incidents).toBeGreaterThan(0);

    // The finished job is gone, and the integration is no longer due.
    await until(
      () => worker.syncQueue.getJobCounts("waiting", "active", "completed", "failed"),
      (counts) => Object.values(counts).every((n) => n === 0),
    );
    expect(await worker.tickNow()).toEqual({ due: 0, enqueued: 0 });
  });

  it("syncs again on its own timer once the interval has passed", async () => {
    const target = await integration();
    await start({ schedulerTickSeconds: 1 });
    const first = await until(
      () => stateOf(target),
      (s) => s.integration?.syncStatus === "ok",
    );

    // Pretend the interval has passed. Nothing triggers a tick by hand.
    await owner.query(
      "UPDATE integrations SET last_sync_started_at = now() - interval '16 minutes' WHERE id = $1",
      [target.integrationId],
    );
    const second = await until(
      () => stateOf(target),
      (s) => (s.integration?.lastSyncAt?.getTime() ?? 0) > first.integration!.lastSyncAt!.getTime(),
    );
    expect(second.integration!.syncStatus).toBe("ok");
    expect(second.results).toBe(first.results); // same history, nothing duplicated
  });

  it("registers exactly one schedule, however many workers start", async () => {
    await start({ schedulerTickSeconds: 30 });
    await start({ schedulerTickSeconds: 30 });
    const scheduler = new Queue(SCHEDULER_QUEUE, { connection: redisConnection(redisUrl), prefix });
    try {
      const schedulers = await scheduler.getJobSchedulers();
      expect(schedulers).toHaveLength(1);
      expect(schedulers[0]).toMatchObject({ key: TICK_SCHEDULER_ID, every: 30_000 });
    } finally {
      await scheduler.close();
    }
  });

  it("syncs several tenants' integrations, each into its own tenant", async () => {
    const targets = await Promise.all([integration(), integration(), integration(), integration()]);
    await start({ syncConcurrency: 2 });

    const states = await until(
      () => Promise.all(targets.map(stateOf)),
      (all) => all.every((s) => s.integration?.syncStatus === "ok"),
      40_000,
    );
    // The same demo fleet, separately, in every tenant.
    expect(new Set(states.map((s) => s.assets)).size).toBe(1);
    expect(states[0]!.assets).toBeGreaterThan(30);
  }, 60_000);

  it("two workers sharing a queue sync each integration once", async () => {
    const target = await integration();
    let syncs = 0;
    const counting: WorkerOptions["connectorFactory"] = () => {
      syncs += 1;
      return {
        vendor: "mock",
        testConnection: async () => undefined,
        listClients: async () => {
          await new Promise((resolve) => setTimeout(resolve, 300)); // long enough to overlap
          return [];
        },
        listAssets: async () => [],
        listResults: async () => [],
        normalizeStatus: () => "unknown",
      };
    };
    const first = await start({ connectorFactory: counting });
    const second = await start({ connectorFactory: counting });
    await Promise.all([first.tickNow(), second.tickNow(), first.tickNow(), second.tickNow()]);

    await until(
      () => stateOf(target),
      (s) => s.integration?.syncStatus === "ok",
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(syncs).toBe(1);
  });

  it("records a failing sync on the integration, removes the job, and keeps working", async () => {
    const failing = await integration({ seed: "demo", simulate: "outage" });
    const healthy = await integration();
    const worker = await start();

    const [bad, good] = await until(
      () => Promise.all([stateOf(failing), stateOf(healthy)]),
      ([a, b]) => a.integration?.syncStatus === "error" && b.integration?.syncStatus === "ok",
    );
    expect(bad.integration).toMatchObject({
      syncStatus: "error",
      lastSyncError: "The vendor API could not be reached.",
      lastSyncAt: null,
    });
    expect(bad.assets).toBe(0);
    expect(good.assets).toBeGreaterThan(0);

    await until(
      () => worker.syncQueue.getJobCounts("waiting", "active", "failed"),
      (counts) => Object.values(counts).every((n) => n === 0),
    );
    // Not retried in a loop: it is tried again when it is next due.
    expect(await worker.tickNow()).toEqual({ due: 0, enqueued: 0 });
  });

  it("recovers a failing integration on a later tick once the vendor is back", async () => {
    const target = await integration({ seed: "demo", simulate: "outage" });
    const worker = await start();
    await until(
      () => stateOf(target),
      (s) => s.integration?.syncStatus === "error",
    );

    // The interval passes, and the vendor recovers.
    await owner.query(
      "UPDATE integrations SET last_sync_started_at = now() - interval '16 minutes' WHERE id = $1",
      [target.integrationId],
    );
    await db.withTenant(target.tenantId, (context) =>
      replaceIntegrationCredentials(context, keyProvider, {
        id: target.integrationId,
        credentials: new Secret({ seed: "demo" }),
        actorUserId: null,
      }),
    );
    expect(await worker.tickNow()).toEqual({ due: 1, enqueued: 1 });
    const state = await until(
      () => stateOf(target),
      (s) => s.integration?.syncStatus === "ok",
    );
    expect(state.integration!.lastSyncError).toBeNull();
  });

  it("quietly skips an integration that was disconnected after being queued", async () => {
    const target = await integration();
    await enqueueDueSyncs({ db, queue, intervalMinutes: 15, logger });
    await db.withTenant(target.tenantId, ({ tx }) =>
      tx.integration.delete({ where: { id: target.integrationId } }),
    );

    const worker = await start();
    await until(
      () => worker.syncQueue.getJobCounts("waiting", "active", "failed", "completed"),
      (counts) => Object.values(counts).every((n) => n === 0),
    );
    expect((await stateOf(target)).integration).toBeNull();
  });

  it("drops a job whose data is not two valid ids, without touching the database", async () => {
    const target = await integration();
    // Not due, so the only job that could reach it is the malformed one.
    await owner.query("UPDATE integrations SET last_sync_started_at = now() WHERE id = $1", [
      target.integrationId,
    ]);
    await queue.add("sync-integration", {
      tenantId: "' OR 1=1 --",
      integrationId: target.integrationId,
    });
    await queue.add("sync-integration", { integrationId: target.integrationId });

    const worker = await start();
    await until(
      () => worker.syncQueue.getJobCounts("waiting", "active"),
      (counts) => counts.waiting === 0 && counts.active === 0,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    const state = await stateOf(target);
    expect(state.integration).toMatchObject({ syncStatus: "never", lastSyncAt: null });
    expect(state.assets).toBe(0);
  });

  it("lets a running sync finish before closing", async () => {
    const target = await integration();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started = false;
    const slow: WorkerOptions["connectorFactory"] = () => ({
      vendor: "mock",
      testConnection: async () => undefined,
      listClients: async () => {
        started = true;
        await gate;
        return [{ vendorClientId: "c1", name: "Late Client" }];
      },
      listAssets: async () => [],
      listResults: async () => [],
      normalizeStatus: () => "unknown",
    });
    const worker = await start({ connectorFactory: slow });
    running.splice(running.indexOf(worker), 1); // closed by this test
    await worker.tickNow();
    await until(
      async () => started,
      (value) => value,
    );

    let closed = false;
    const closing = worker.close().then(() => (closed = true));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(closed).toBe(false); // still waiting for the sync

    release();
    await closing;
    const state = await stateOf(target);
    expect(state.integration).toMatchObject({ syncStatus: "ok" });
    expect(await db.withTenant(target.tenantId, ({ tx }) => tx.client.count())).toBe(1);
  });
});
