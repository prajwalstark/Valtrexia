import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import type { Connector, NormalizedStatus, VendorResult } from "@valtrexia/connectors";
import { AuthError } from "@valtrexia/connectors";
import { brand } from "@valtrexia/core";
import {
  createLogger,
  generateWebhookSecret,
  LocalKeyProvider,
  Secret,
  verifyWebhook,
} from "@valtrexia/core/server";
import {
  claimNotificationBatch,
  createDb,
  createIntegration,
  createWebhookChannel,
  queueIncidentNotifications,
  replaceIntegrationCredentials,
  type ChannelPreferencesInput,
  type Db,
} from "@valtrexia/db";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { syncIntegration, type SyncDeps } from "../sync/sync-integration";
import { deliverBatch, deliverDueNotifications, type DeliveryDeps } from "./deliver";

const urls = inject("databaseUrls");
const HOUR = 3_600_000;
const MINUTE = 60_000;
const T0 = new Date("2026-11-12T12:00:00Z");
const at = (hours: number) => new Date(T0.getTime() + hours * HOUR);

let db: Db;
const keyProvider = new LocalKeyProvider(randomBytes(32).toString("base64"));
const logLines: string[] = [];
const logger = createLogger({
  name: "notify-test",
  level: "debug",
  destination: new Writable({
    write(chunk: Buffer, _encoding, done) {
      logLines.push(chunk.toString());
      done();
    },
  }),
});

// A receiver on this machine. Each channel gets its own path, so a test
// sees only the requests meant for it; the status to answer with is set per path.
interface Received {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}
let server: Server;
let base: string;
const received: Received[] = [];
const answer = new Map<string, number>();
const RELAXED = { allowHttp: true, allowPrivate: true };

beforeAll(async () => {
  db = createDb({ url: urls.app });
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      received.push({ path: request.url!, headers: request.headers, body });
      response.writeHead(answer.get(request.url!) ?? 204).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await db.disconnect();
});
beforeEach(() => {
  logLines.length = 0;
});

/** A vendor with one client and whatever assets and results the test gives it. */
class ScriptedVendor {
  assets = new Map<string, { isPaused: boolean }>();
  results: { asset: string; at: Date; status: NormalizedStatus }[] = [];
  failure: Error | null = null;

  result(asset: string, when: Date, status: NormalizedStatus) {
    if (!this.assets.has(asset)) this.assets.set(asset, { isPaused: false });
    this.results.push({ asset, at: when, status });
    return this;
  }
  connector(): Connector {
    const fail = () => {
      if (this.failure) throw this.failure;
    };
    return {
      vendor: "mock",
      testConnection: async () => fail(),
      listClients: async () => (fail(), [{ vendorClientId: "c1", name: "Acme Dental" }]),
      listAssets: async () => (
        fail(),
        [...this.assets].map(([name, flags]) => ({
          vendorAssetId: name,
          vendorClientId: "c1",
          name,
          type: "agent",
          deviceName: null,
          expectedFrequencyHours: 24,
          isPaused: flags.isPaused,
          isArchived: false,
        }))
      ),
      listResults: async (since) => (
        fail(),
        this.results
          .filter((r) => r.at.getTime() >= since.getTime())
          .map((r): VendorResult => ({
            vendorResultId: `${r.asset}-${r.at.getTime()}`,
            vendorAssetId: r.asset,
            startedAt: r.at,
            endedAt: r.at,
            vendorStatusRaw: r.status,
            message: null,
            screenshotVerified: null,
            rawPayload: { status: r.status, apiKey: "vendor-raw-payload-must-not-leak" },
          }))
      ),
      normalizeStatus: (raw) => (raw as { status: NormalizedStatus }).status,
    };
  }
}

const ALL: ChannelPreferencesInput = {
  incidentTypes: ["failed", "missed", "stale"],
  notifyOpened: true,
  notifyClosed: true,
  notifyIntegrationHealth: true,
};

async function setup(vendor: ScriptedVendor) {
  const tenantId = await db.provisionTenant({
    clerkOrgId: `org_${randomUUID()}`,
    name: "Northwind IT",
  });
  const integration = await db.withTenant(tenantId, (context) =>
    createIntegration(context, keyProvider, {
      vendor: "mock",
      name: "Scripted",
      credentials: new Secret({ seed: "unused" }),
      actorUserId: null,
    }),
  );
  const target = { tenantId, integrationId: integration.id };
  const sync = (now: Date) => {
    const deps: SyncDeps = {
      db,
      keyProvider,
      logger,
      allowMock: true,
      now: () => now,
      connectorFactory: () => vendor.connector(),
    };
    return syncIntegration(deps, target);
  };

  /** Adds a webhook channel pointing at the local receiver. Returns its path and secret. */
  const channel = async (name: string, preferences: Partial<ChannelPreferencesInput> = {}) => {
    const path = `/hook/${randomUUID()}?token=path-token-must-not-leak`;
    const signingSecret = generateWebhookSecret();
    const created = await db.withTenant(tenantId, (context) =>
      createWebhookChannel(context, keyProvider, {
        name,
        destination: new Secret({ url: `${base}${path}`, signingSecret }),
        preferences: { ...ALL, ...preferences },
        actorUserId: null,
      }),
    );
    return { id: created.id, path, signingSecret };
  };

  const deliveryDeps = (now: Date, overrides: Partial<DeliveryDeps> = {}): DeliveryDeps => ({
    db,
    keyProvider,
    logger,
    outboundPolicy: RELAXED,
    now: () => now,
    ...overrides,
  });

  const batches = () =>
    db.withTenant(tenantId, ({ tx }) =>
      tx.notificationBatch.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    );

  /** Sends this tenant's pending batches as of `now`, as the worker would. */
  const deliver = async (now: Date, overrides: Partial<DeliveryDeps> = {}) => {
    const pending = (await batches()).filter((b) => b.status === "pending");
    const results = [];
    for (const batch of pending) {
      results.push(
        await deliverBatch(deliveryDeps(now, overrides), { tenantId, batchId: batch.id }),
      );
    }
    return results;
  };

  return { tenantId, target, sync, channel, batches, deliver, deliveryDeps, integration };
}

const to = (path: string) => received.filter((request) => request.path === path);
const bodies = (path: string) =>
  to(path).map((request) => JSON.parse(request.body) as Record<string, unknown>);
interface IncidentsBody {
  type: string;
  data: {
    workspace: { name: string };
    opened: { type: string; asset: { name: string }; client: { name: string } }[];
    closed: { type: string; asset: { name: string } }[];
  };
}
const summary = (body: IncidentsBody) => ({
  opened: body.data.opened.map((i) => `${i.asset.name}:${i.type}`).sort(),
  closed: body.data.closed.map((i) => `${i.asset.name}:${i.type}`).sort(),
});

describe("notifications: incidents", () => {
  it("sends one signed message per sync, listing every incident that opened", async () => {
    const vendor = new ScriptedVendor()
      .result("SQL01", at(-30), "success")
      .result("SQL01", at(-1), "failed")
      .result("FS01", at(-40), "success")
      .result("WEB01", at(-2), "success");
    const s = await setup(vendor);
    const hook = await s.channel("Ops webhook");

    const synced = await s.sync(T0);
    expect(synced).toMatchObject({ incidentsOpened: 3, notificationsQueued: 1 });
    expect(await s.deliver(T0)).toEqual([
      { batchId: expect.any(String) as string, result: "sent" },
    ]);

    const [request] = to(hook.path);
    expect(to(hook.path)).toHaveLength(1);
    expect(request!.headers["content-type"]).toBe("application/json");
    expect(request!.headers["user-agent"]).toBe(`${brand.name}-Webhooks/1`);
    expect(request!.headers["webhook-id"]).toBe((await s.batches())[0]!.id);
    expect(
      verifyWebhook(request!.headers as Record<string, string>, request!.body, hook.signingSecret, {
        now: T0,
      }),
    ).toBe(true);

    const body = JSON.parse(request!.body) as IncidentsBody;
    expect(body.type).toBe("incidents.changed");
    expect(body.data.workspace).toEqual({ name: "Northwind IT" });
    expect(summary(body)).toEqual({
      opened: ["FS01:missed", "SQL01:failed", "SQL01:missed"],
      closed: [],
    });
    expect(body.data.opened[0]!.client.name).toBe("Acme Dental");
    expect(await s.batches()).toMatchObject([
      { status: "sent", attempts: 1, sentAt: T0, lastError: null },
    ]);
  });

  it("never tells a channel the same thing twice, however often the sync runs", async () => {
    const vendor = new ScriptedVendor().result("FS01", at(-40), "success");
    const s = await setup(vendor);
    const hook = await s.channel("Ops webhook");

    await s.sync(T0);
    await s.sync(T0);
    await s.sync(at(0.25));
    expect(await s.batches()).toHaveLength(1);
    await s.deliver(at(0.5));
    await s.deliver(at(0.5));
    expect(to(hook.path)).toHaveLength(1);
  });

  it("says when incidents close because a backup completed", async () => {
    const vendor = new ScriptedVendor().result("FS01", at(-40), "success");
    const s = await setup(vendor);
    const hook = await s.channel("Ops webhook");
    await s.sync(T0);
    vendor.result("FS01", at(1), "success");
    expect(await s.sync(at(2))).toMatchObject({ incidentsClosed: 1, notificationsQueued: 1 });
    await s.deliver(at(2));
    expect(bodies(hook.path).map((b) => summary(b as unknown as IncidentsBody))).toEqual([
      { opened: ["FS01:missed"], closed: [] },
      { opened: [], closed: ["FS01:missed"] },
    ]);
  });

  it("says nothing when an incident closes because the vendor paused the asset", async () => {
    const vendor = new ScriptedVendor().result("FS01", at(-40), "success");
    const s = await setup(vendor);
    await s.channel("Ops webhook");
    await s.sync(T0);
    vendor.assets.set("FS01", { isPaused: true });
    expect(await s.sync(at(1))).toMatchObject({ incidentsClosed: 1, notificationsQueued: 0 });
    expect(await s.batches()).toHaveLength(1);
  });

  it("follows each channel's choices, and sends nothing with no channel at all", async () => {
    const vendor = new ScriptedVendor()
      .result("SQL01", at(-100), "success")
      .result("SQL01", at(-1), "failed");
    const s = await setup(vendor);
    const all = await s.channel("Everything");
    const stale = await s.channel("Stale only", { incidentTypes: ["stale"] });
    const closings = await s.channel("Closures only", { notifyOpened: false });

    expect(await s.sync(T0)).toMatchObject({ incidentsOpened: 3, notificationsQueued: 2 });
    await s.deliver(T0);
    expect(summary(bodies(all.path)[0] as unknown as IncidentsBody).opened).toEqual([
      "SQL01:failed",
      "SQL01:missed",
      "SQL01:stale",
    ]);
    expect(summary(bodies(stale.path)[0] as unknown as IncidentsBody).opened).toEqual([
      "SQL01:stale",
    ]);
    expect(to(closings.path)).toHaveLength(0);

    const quiet = await setup(new ScriptedVendor().result("X", at(-100), "success"));
    expect(await quiet.sync(T0)).toMatchObject({ incidentsOpened: 2, notificationsQueued: 0 });
  });

  it("tells a disabled channel nothing", async () => {
    const vendor = new ScriptedVendor().result("FS01", at(-40), "success");
    const s = await setup(vendor);
    const hook = await s.channel("Ops webhook");
    await db.withTenant(s.tenantId, ({ tx }) =>
      tx.notificationChannel.update({ where: { id: hook.id }, data: { enabled: false } }),
    );
    expect(await s.sync(T0)).toMatchObject({ notificationsQueued: 0 });
  });

  it("keeps one workspace's news from another workspace's channels", async () => {
    const one = await setup(new ScriptedVendor().result("ONE", at(-40), "success"));
    const two = await setup(new ScriptedVendor().result("TWO", at(-2), "success"));
    const oneHook = await one.channel("Hook");
    const twoHook = await two.channel("Hook");
    await one.sync(T0);
    await two.sync(T0);
    await one.deliver(T0);
    await two.deliver(T0);
    expect(to(oneHook.path)).toHaveLength(1);
    expect(to(twoHook.path)).toHaveLength(0);
    expect(await two.batches()).toEqual([]);
  });
});

describe("notifications: delivery", () => {
  it("retries a failed send on a schedule, with the same message id each time", async () => {
    const vendor = new ScriptedVendor().result("FS01", at(-40), "success");
    const s = await setup(vendor);
    const hook = await s.channel("Flaky webhook");
    answer.set(hook.path, 503);
    await s.sync(T0);

    expect(await s.deliver(T0)).toMatchObject([{ result: "retrying" }]);
    expect(await s.batches()).toMatchObject([
      {
        status: "pending",
        attempts: 1,
        nextAttemptAt: new Date(T0.getTime() + MINUTE),
        lastError: "The endpoint answered with HTTP 503.",
      },
    ]);
    // Not due again until its time comes.
    expect(await s.deliver(new Date(T0.getTime() + 30_000))).toMatchObject([{ result: "skipped" }]);

    answer.set(hook.path, 200);
    expect(await s.deliver(new Date(T0.getTime() + MINUTE))).toMatchObject([{ result: "sent" }]);
    const ids = to(hook.path).map((request) => request.headers["webhook-id"]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(1);
    expect(await s.batches()).toMatchObject([{ status: "sent", attempts: 2, lastError: null }]);
  });

  it("gives up after eight attempts", async () => {
    const vendor = new ScriptedVendor().result("FS01", at(-40), "success");
    const s = await setup(vendor);
    const hook = await s.channel("Broken webhook");
    answer.set(hook.path, 500);
    await s.sync(T0);

    let now = T0;
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const [result] = await s.deliver(now);
      expect(result!.result).toBe(attempt < 8 ? "retrying" : "failed");
      now = new Date(now.getTime() + 5 * HOUR);
    }
    expect(await s.batches()).toMatchObject([{ status: "failed", attempts: 8 }]);
    expect(await s.deliver(now)).toEqual([]);
    expect(to(hook.path)).toHaveLength(8);
  });

  it("stops at once when the endpoint says it no longer exists", async () => {
    const vendor = new ScriptedVendor().result("FS01", at(-40), "success");
    const s = await setup(vendor);
    const hook = await s.channel("Gone webhook");
    answer.set(hook.path, 410);
    await s.sync(T0);
    expect(await s.deliver(T0)).toMatchObject([{ result: "failed" }]);
    expect((await s.batches())[0]!.lastError).toMatch(/no longer exists \(HTTP 410\)/);
  });

  it("refuses a private destination under the normal policy, without connecting", async () => {
    const vendor = new ScriptedVendor().result("FS01", at(-40), "success");
    const s = await setup(vendor);
    const hook = await s.channel("Internal webhook");
    await s.sync(T0);
    expect(await s.deliver(T0, { outboundPolicy: {} })).toMatchObject([{ result: "failed" }]);
    expect((await s.batches())[0]!.lastError).toBe("The URL must start with https://.");
    expect(to(hook.path)).toHaveLength(0);
  });

  it("does not send to a channel turned off after the message was queued", async () => {
    const vendor = new ScriptedVendor().result("FS01", at(-40), "success");
    const s = await setup(vendor);
    const hook = await s.channel("Ops webhook");
    await s.sync(T0);
    await db.withTenant(s.tenantId, ({ tx }) =>
      tx.notificationChannel.update({ where: { id: hook.id }, data: { enabled: false } }),
    );
    expect(await s.deliver(T0)).toMatchObject([{ result: "failed" }]);
    expect(to(hook.path)).toHaveLength(0);
  });

  it("sends a message once even when two workers reach for it at the same moment", async () => {
    const vendor = new ScriptedVendor().result("FS01", at(-40), "success");
    const s = await setup(vendor);
    const hook = await s.channel("Ops webhook");
    await s.sync(T0);
    const [batch] = await s.batches();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        deliverBatch(s.deliveryDeps(T0), { tenantId: s.tenantId, batchId: batch!.id }),
      ),
    );
    expect(results.filter((r) => r.result === "sent")).toHaveLength(1);
    expect(results.filter((r) => r.result === "skipped")).toHaveLength(4);
    expect(to(hook.path)).toHaveLength(1);
  });

  it("finds due messages across workspaces and sends them", async () => {
    const vendor = new ScriptedVendor().result("FS01", at(-40), "success");
    const s = await setup(vendor);
    const hook = await s.channel("Ops webhook");
    await s.sync(T0);
    const [batch] = await s.batches();
    const results = await deliverDueNotifications(s.deliveryDeps(new Date()));
    expect(results).toContainEqual({ batchId: batch!.id, result: "sent" });
    expect(to(hook.path)).toHaveLength(1);
  });

  it("logs ids and outcomes, never the destination, its token, the secret or a vendor payload", async () => {
    const vendor = new ScriptedVendor().result("FS01", at(-40), "success");
    const s = await setup(vendor);
    const hook = await s.channel("Ops webhook");
    answer.set(hook.path, 500);
    await s.sync(T0);
    await s.deliver(T0);
    const log = logLines.join("\n");
    expect(log).toContain("notification will be retried");
    for (const secret of [
      "path-token-must-not-leak",
      hook.signingSecret,
      base,
      "vendor-raw-payload-must-not-leak",
    ]) {
      expect(log).not.toContain(secret);
    }
    // The message itself carries names and times, never a vendor's raw payload.
    expect(to(hook.path)[0]!.body).not.toContain("vendor-raw-payload-must-not-leak");
  });
});

describe("notifications: the outbox's own guarantees", () => {
  it("queues a change for a channel once, however often it is offered", async () => {
    const vendor = new ScriptedVendor().result("FS01", at(-40), "success");
    const s = await setup(vendor);
    await s.channel("Ops webhook");
    await s.sync(T0);
    const incident = await db.withTenant(s.tenantId, ({ tx }) =>
      tx.incident.findFirstOrThrow({ include: { asset: { include: { client: true } } } }),
    );
    const change = {
      incidentId: incident.id,
      type: incident.type as "missed",
      event: "opened" as const,
      reason: null,
      client: { id: incident.asset.client.id, name: incident.asset.client.name },
      asset: { id: incident.asset.id, name: incident.asset.name },
      openedAt: incident.openedAt,
      closedAt: null,
      lastBackupAt: null,
    };
    // The sync already queued it. Offering it again, twice, adds nothing.
    for (let i = 0; i < 2; i += 1) {
      const queued = await db.withTenant(s.tenantId, (context) =>
        queueIncidentNotifications(context, { changes: [change], now: at(1) }),
      );
      expect(queued).toBe(0);
    }
    expect(await s.batches()).toHaveLength(1);
  });

  it("lets only one worker claim a batch until its lease runs out", async () => {
    const vendor = new ScriptedVendor().result("FS01", at(-40), "success");
    const s = await setup(vendor);
    await s.channel("Ops webhook");
    await s.sync(T0);
    const [batch] = await s.batches();
    const claim = (now: Date) =>
      db.withTenant(s.tenantId, (context) =>
        claimNotificationBatch(context, { batchId: batch!.id, now, leaseMs: 2 * MINUTE }),
      );

    expect(await claim(T0)).toMatchObject({ id: batch!.id, attempts: 1 });
    // A second worker, a moment later: the batch is reserved.
    expect(await claim(new Date(T0.getTime() + MINUTE))).toBeNull();
    // The first worker died without recording anything. Once the lease runs
    // out, the batch can be taken again.
    expect(await claim(new Date(T0.getTime() + 2 * MINUTE))).toMatchObject({ attempts: 2 });
  });
});

describe("notifications: integration health", () => {
  it("says once that an integration is unhealthy, and once that it recovered", async () => {
    const vendor = new ScriptedVendor().result("FS01", at(-2), "success");
    const s = await setup(vendor);
    const hook = await s.channel("Ops webhook");
    await s.sync(T0);

    vendor.failure = new Error("vendor is down");
    for (let i = 1; i <= 6; i += 1) {
      await expect(s.sync(at(i * 0.25))).rejects.toThrow();
    }
    await s.deliver(at(2));
    vendor.failure = null;
    await s.sync(at(3));
    await s.sync(at(3.25));
    await s.deliver(at(3.5));

    const messages = bodies(hook.path) as {
      type: string;
      data: { integration: { name: string }; error: string | null; failingSince: string };
    }[];
    expect(messages.map((m) => m.type)).toEqual(["integration.unhealthy", "integration.recovered"]);
    expect(messages[0]!.data).toMatchObject({
      integration: { name: "Scripted" },
      error: "The sync failed unexpectedly. It will be retried.",
      failingSince: at(0.25).toISOString(),
    });
    // Each was signed when it was sent: at 14:00 and at 15:30.
    const sentAt = [at(2), at(3.5)];
    to(hook.path).forEach((request, index) => {
      const headers = request.headers as Record<string, string>;
      expect(
        verifyWebhook(headers, request.body, hook.signingSecret, { now: sentAt[index]! }),
      ).toBe(true);
    });
  });

  it("says at the first failure when the key is rejected, and that the keys need replacing", async () => {
    const vendor = new ScriptedVendor().result("FS01", at(-2), "success");
    const s = await setup(vendor);
    const hook = await s.channel("Ops webhook");
    vendor.failure = new AuthError(401);
    await expect(s.sync(T0)).rejects.toThrow();
    await expect(s.sync(at(0.25))).rejects.toThrow();
    await s.deliver(at(0.5));
    expect(bodies(hook.path)).toMatchObject([
      { type: "integration.unhealthy", data: { needsAction: true } },
    ]);

    // New keys reset the failure count. The recovery is still reported, by
    // the first sync that succeeds with them.
    await db.withTenant(s.tenantId, (context) =>
      replaceIntegrationCredentials(context, keyProvider, {
        id: s.integration.id,
        credentials: new Secret({ seed: "new" }),
        actorUserId: null,
      }),
    );
    vendor.failure = null;
    await s.sync(at(1));
    await s.deliver(at(1));
    expect(bodies(hook.path).map((m) => m.type)).toEqual([
      "integration.unhealthy",
      "integration.recovered",
    ]);
  });

  it("says nothing about a brief failure that clears by itself", async () => {
    const vendor = new ScriptedVendor().result("FS01", at(-2), "success");
    const s = await setup(vendor);
    await s.channel("Ops webhook");
    vendor.failure = new Error("blip");
    await expect(s.sync(T0)).rejects.toThrow();
    vendor.failure = null;
    await s.sync(at(0.25));
    expect(await s.batches()).toEqual([]);
  });

  it("respects a channel that does not want integration news", async () => {
    const vendor = new ScriptedVendor();
    const s = await setup(vendor);
    await s.channel("Incidents only", { notifyIntegrationHealth: false });
    vendor.failure = new AuthError(403);
    await expect(s.sync(T0)).rejects.toThrow();
    expect(await s.batches()).toEqual([]);
  });
});
