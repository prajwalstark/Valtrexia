import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import {
  createLogger,
  EmailSendError,
  fleetSnapshotKey,
  generateWebhookSecret,
  LocalKeyProvider,
  maintenanceStatusKey,
  MemoryEmailSender,
  Secret,
  verifyWebhook,
  type FleetSnapshot,
} from "@valtrexia/core/server";
import { createDb, createIntegration, type Db, type FleetHealthCounts } from "@valtrexia/db";
import { Redis } from "ioredis";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { runOperatorCheck, type OperatorCheckDeps } from "./check";

const urls = inject("databaseUrls");
let db: Db;
let owner: pg.Pool;
let redis: Redis;
let server: Server;
let hookUrl: string;
const received: { headers: IncomingHttpHeaders; body: string }[] = [];
let answer = 200;
const logLines: string[] = [];
const logger = createLogger({
  name: "operator-test",
  level: "debug",
  destination: new Writable({
    write(chunk: Buffer, _e, done) {
      logLines.push(chunk.toString());
      done();
    },
  }),
});
const keyProvider = new LocalKeyProvider(randomBytes(32).toString("base64"));
const SECRET = generateWebhookSecret();

beforeAll(async () => {
  db = createDb({ url: urls.app });
  owner = new pg.Pool({ connectionString: urls.owner, max: 1 });
  redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      received.push({ headers: request.headers, body });
      response.statusCode = answer;
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  hookUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/operator`;
});
afterAll(async () => {
  await db.disconnect();
  await owner.end();
  redis.disconnect();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(async () => {
  // Alerts are global: start every test from none open, whatever ran before.
  await owner.query(
    `UPDATE operator_alerts SET closed_at = GREATEST(now(), opened_at),
       open_notified_at = COALESCE(open_notified_at, now()), close_notified_at = now()
     WHERE closed_at IS NULL OR close_notified_at IS NULL OR open_notified_at IS NULL`,
  );
  received.length = 0;
  answer = 200;
});

const HEALTHY: FleetHealthCounts = {
  integrationsTotal: 40,
  integrationsFailing: 0,
  integrationsOverdue: 0,
  batchesOverdue: 0,
  batchesFailedLastHour: 0,
};

/** The worker's deps, with the fleet's counts fixed (other test files share the database). */
function deps(counts: FleetHealthCounts, extra: Partial<OperatorCheckDeps> = {}) {
  const prefix = `test-${randomUUID()}`;
  const email = new MemoryEmailSender();
  const base: OperatorCheckDeps = {
    db: { ...db, fleetHealthCounts: async () => counts },
    logger,
    redis,
    prefix,
    syncIntervalMinutes: 15,
    queues: [
      { name: "sync", counts: async () => ({ waiting: 2, active: 1, delayed: 0, failed: 0 }) },
    ],
    alerts: { emails: ["ops@operator.example"], webhookUrl: hookUrl, webhookSecret: SECRET },
    emailSender: email,
    outboundPolicy: { allowHttp: true, allowPrivate: true },
    ...extra,
  };
  return { base, email, prefix };
}

describe("operator check", () => {
  it("records the fleet's numbers where the status endpoint reads them, and logs them", async () => {
    const { base, prefix } = deps(HEALTHY);
    await redis.set(
      maintenanceStatusKey(prefix),
      JSON.stringify({ ok: true, at: "2026-11-20T06:00:00Z" }),
    );
    logLines.length = 0;
    const result = await runOperatorCheck(base);
    expect(result).toMatchObject({ opened: [], closed: [], notified: 0 });
    const stored = JSON.parse((await redis.get(fleetSnapshotKey(prefix)))!) as FleetSnapshot;
    expect(stored).toMatchObject({
      integrations: { total: 40, failing: 0, overdue: 0 },
      maintenance: { ok: true },
      queues: { sync: { waiting: 2, active: 1, delayed: 0, failed: 0 } },
    });
    expect(await redis.ttl(fleetSnapshotKey(prefix))).toBeGreaterThan(0);
    expect(logLines.join("\n")).toContain('"metric":"fleet_health"');
  });

  it("tells the operator once when a condition starts, once when it clears, by email and signed webhook", async () => {
    const failing = { ...HEALTHY, integrationsFailing: 12 };
    const { base, email } = deps(failing);

    const first = await runOperatorCheck(base);
    expect(first).toMatchObject({ opened: ["integrations_failing"], notified: 1, unreported: 0 });
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]).toMatchObject({ to: ["ops@operator.example"] });
    expect(email.sent[0]!.subject).toMatch(/operator\] Syncs are failing across many workspaces$/);
    expect(email.sent[0]!.text).toContain("12 of 40 integrations failed their last sync.");
    expect(received).toHaveLength(1);
    const hook = received[0]!;
    expect(JSON.parse(hook.body)).toMatchObject({
      type: "operator_alert.opened",
      condition: "integrations_failing",
      details: { failing: 12, total: 40 },
    });
    expect(
      verifyWebhook(
        {
          "webhook-id": hook.headers["webhook-id"] as string,
          "webhook-timestamp": hook.headers["webhook-timestamp"] as string,
          "webhook-signature": hook.headers["webhook-signature"] as string,
        },
        hook.body,
        SECRET,
        { now: new Date() },
      ),
    ).toBe(true);

    // Still failing: nothing new to say.
    expect(await runOperatorCheck(base)).toMatchObject({ opened: [], notified: 0 });
    expect(email.sent).toHaveLength(1);

    // Recovered.
    const cleared = await runOperatorCheck({
      ...base,
      db: { ...db, fleetHealthCounts: async () => HEALTHY },
    });
    expect(cleared).toMatchObject({ closed: ["integrations_failing"], notified: 1 });
    expect(email.sent[1]!.subject).toContain("Resolved: Syncs are failing");
    expect(JSON.parse(received[1]!.body)).toMatchObject({ type: "operator_alert.closed" });
  });

  it("keeps trying to report until every destination has it, without opening the alert twice", async () => {
    const backlog = { ...HEALTHY, batchesOverdue: 250 };
    const { base, email } = deps(backlog);
    answer = 503;
    expect(await runOperatorCheck(base)).toMatchObject({
      opened: ["notifications_backlog"],
      notified: 0,
      unreported: 1,
    });
    answer = 200;
    expect(await runOperatorCheck(base)).toMatchObject({ opened: [], notified: 1, unreported: 0 });
    // The email went out both times under one key; the provider drops the repeat.
    expect(new Set(email.sent.map((m) => m.idempotencyKey)).size).toBe(1);
    expect(
      received.filter((r) => JSON.parse(r.body).type === "operator_alert.opened"),
    ).toHaveLength(2);

    email.failure = new EmailSendError(true, "down");
    await runOperatorCheck({ ...base, db: { ...db, fleetHealthCounts: async () => HEALTHY } });
    const open = await db.operatorAlertsToNotify(new Date(Date.now() - 3_600_000));
    expect(open.map((a) => a.condition)).toContain("notifications_backlog");
  });

  it("raises an alert when the last maintenance run failed", async () => {
    const { base, prefix } = deps(HEALTHY);
    await redis.set(
      maintenanceStatusKey(prefix),
      JSON.stringify({ ok: false, at: "2026-11-20T06:00:00Z" }),
    );
    expect((await runOperatorCheck(base)).opened).toEqual(["maintenance_failing"]);
  });

  it("only logs, and keeps the alert to report, when no destination is configured", async () => {
    const { base } = deps({ ...HEALTHY, integrationsOverdue: 3 });
    logLines.length = 0;
    const result = await runOperatorCheck({
      ...base,
      alerts: { emails: [], webhookUrl: null, webhookSecret: null },
    });
    expect(result).toMatchObject({ opened: ["integrations_overdue"], notified: 0, unreported: 1 });
    expect(logLines.join("\n")).toContain("operator alerts have nowhere to go");
  });
});

describe("fleet health counts", () => {
  it("counts across tenants, leaving out workspaces waiting to be deleted, and returns numbers only", async () => {
    const before = await db.fleetHealthCounts({ overdueAfterMinutes: 60 });
    const make = async (deleting: boolean) => {
      const tenantId = await db.provisionTenant({ clerkOrgId: `org_${randomUUID()}`, name: "MSP" });
      await db.withTenant(tenantId, async (context) => {
        const integration = await createIntegration(context, keyProvider, {
          vendor: "mock",
          name: "Demo",
          credentials: new Secret({ seed: "x" }),
          actorUserId: null,
        });
        await context.tx.integration.update({
          where: { id: integration.id },
          data: { syncStatus: "error", lastSyncAt: new Date(Date.now() - 3 * 3_600_000) },
        });
      });
      if (deleting) {
        await owner.query(
          "UPDATE tenants SET deletion_requested_at = now(), delete_after = now() + interval '30 days', deletion_reason = 'owner_request' WHERE id = $1",
          [tenantId],
        );
      }
    };
    await make(false);
    await make(true);
    const after = await db.fleetHealthCounts({ overdueAfterMinutes: 60 });
    expect(after.integrationsTotal - before.integrationsTotal).toBe(1);
    expect(after.integrationsFailing - before.integrationsFailing).toBe(1);
    expect(after.integrationsOverdue - before.integrationsOverdue).toBe(1);
    expect(Object.values(after).every((n) => typeof n === "number")).toBe(true);
  });

  it("opens at most one alert per condition", async () => {
    const first = await db.openOperatorAlert("integrations_overdue", { overdue: 1 });
    const second = await db.openOperatorAlert("integrations_overdue", { overdue: 2 });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(
      (await db.openOperatorAlerts()).filter((a) => a.condition === "integrations_overdue"),
    ).toHaveLength(1);
  });
});
