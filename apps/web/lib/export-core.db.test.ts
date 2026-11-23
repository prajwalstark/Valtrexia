import { randomBytes, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { LocalKeyProvider, Secret } from "@valtrexia/core/server";
import {
  createDb,
  createEmailChannel,
  createIntegration,
  createWebhookChannel,
  type Db,
} from "@valtrexia/db";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { EXPORT_FORMAT, exportWorkspace, gzipStream, startWorkspaceExport } from "./export-core";
import { createRateLimiter, RateLimiterUnavailableError } from "./rate-limit";
import type { TenantSession } from "./session-core";

const urls = inject("databaseUrls");
let db: Db;
const keyProvider = new LocalKeyProvider(randomBytes(32).toString("base64"));
beforeAll(() => {
  db = createDb({ url: urls.app });
});
afterAll(async () => {
  await db.disconnect();
});

// What must never leave in an export, planted where it would be found.
const VENDOR_SECRET = "vendor-secret-key-must-not-export";
const HOOK_TOKEN = "hook-path-token-must-not-export";
const RAW_MARKER = "raw-vendor-record-must-not-export";
const PREFS = {
  incidentTypes: ["failed" as const],
  notifyOpened: true,
  notifyClosed: true,
  notifyIntegrationHealth: true,
};

/** A workspace with a little of everything. */
async function workspace(label: string, results = 3) {
  const tenantId = await db.provisionTenant({
    clerkOrgId: `org_${randomUUID()}`,
    name: `${label} MSP`,
  });
  return db.withTenant(tenantId, async (context) => {
    const { tx } = context;
    const user = async (role: "owner" | "technician") => {
      const row = await tx.user.create({
        data: {
          tenantId,
          clerkUserId: `user_${randomUUID()}`,
          email: `${role}@${label}.example`,
          role,
        },
      });
      return {
        tenantId,
        userId: row.id,
        clerkUserId: row.clerkUserId,
        role,
      } satisfies TenantSession;
    };
    const owner = await user("owner");
    const tech = await user("technician");
    const integration = await createIntegration(context, keyProvider, {
      vendor: "datto_bcdr",
      name: `${label} Datto`,
      credentials: new Secret({ publicKey: "pk-0001", secretKey: VENDOR_SECRET }),
      credentialHint: "0001",
      actorUserId: owner.userId,
    });
    const client = await tx.client.create({ data: { tenantId, name: `${label} Dental` } });
    await tx.vendorClientMapping.create({
      data: {
        tenantId,
        integrationId: integration.id,
        clientId: client.id,
        vendorClientId: "c-1",
        vendorClientName: `${label} Dental`,
      },
    });
    const asset = await tx.asset.create({
      data: {
        tenantId,
        clientId: client.id,
        integrationId: integration.id,
        vendorAssetId: "a-1",
        name: `${label}-SRV01`,
        type: "agent",
      },
    });
    for (let i = 0; i < results; i += 1) {
      await tx.backupResult.create({
        data: {
          tenantId,
          assetId: asset.id,
          integrationId: integration.id,
          vendorResultId: `r-${i}`,
          startedAt: new Date(Date.UTC(2026, 10, 1 + i)),
          status: i === 0 ? "failed" : "success",
          vendorStatusRaw: i === 0 ? "Failed" : "Success",
          rawPayload: { marker: RAW_MARKER, i },
        },
      });
    }
    await tx.incident.create({ data: { tenantId, assetId: asset.id, type: "failed" } });
    await createWebhookChannel(context, keyProvider, {
      name: "Hook",
      destination: new Secret({
        url: `https://hooks.${label}.example/${HOOK_TOKEN}`,
        signingSecret: "whsec_c2lnbmluZy1zZWNyZXQtbXVzdC1ub3QtZXhwb3J0",
      }),
      preferences: PREFS,
      actorUserId: owner.userId,
    });
    await createEmailChannel(context, {
      name: "On-call",
      recipients: [`oncall@${label}.example`],
      preferences: PREFS,
      actorUserId: owner.userId,
    });
    return { tenantId, owner, tech, integrationId: integration.id };
  });
}

async function collect(chunks: AsyncGenerator<string>): Promise<string> {
  let text = "";
  for await (const chunk of chunks) text += chunk;
  return text;
}

describe("workspace export", () => {
  it("holds every section of the workspace, and nothing secret", async () => {
    const mine = await workspace("northwind", 5);
    await workspace("contoso");
    // Should a webhook's settings ever hold more than its host (an older
    // shape, a new field), only the host is exported.
    await db.withTenant(mine.tenantId, ({ tx }) =>
      tx.notificationChannel.updateMany({
        where: { type: "webhook" },
        data: {
          config: {
            host: "hooks.northwind.example",
            url: `https://hooks.northwind.example/${HOOK_TOKEN}`,
          },
        },
      }),
    );
    // Pages of two, so every section with more than two rows is read in several.
    const text = await collect(exportWorkspace({ db, pageSize: 2 }, mine.owner));
    const doc = JSON.parse(text) as Record<string, unknown> &
      Record<string, Record<string, unknown>[]>;

    expect(doc).toMatchObject({
      format: EXPORT_FORMAT,
      version: 1,
      workspace: { name: "northwind MSP", timeZone: "UTC", graceHours: 2 },
    });
    expect(Object.keys(doc)).toEqual([
      "format",
      "version",
      "exportedAt",
      "workspace",
      "members",
      "integrations",
      "clients",
      "vendorClientMappings",
      "assets",
      "backupResults",
      "incidents",
      "notificationChannels",
      "auditLog",
      "notLeftOut",
    ]);
    expect(doc.members!.map((m) => m.email).sort()).toEqual([
      "owner@northwind.example",
      "technician@northwind.example",
    ]);
    expect(doc.integrations).toMatchObject([
      { vendor: "datto_bcdr", name: "northwind Datto", credentialHint: "0001" },
    ]);
    expect(doc.backupResults).toHaveLength(5);
    expect(new Set(doc.backupResults!.map((r) => r.id)).size).toBe(5);
    expect(Object.keys(doc.backupResults![0]!)).not.toContain("rawPayload");
    expect(doc.incidents).toHaveLength(1);
    expect(doc.notificationChannels!.map((c) => [c.type, c.destination]).sort()).toEqual([
      ["email", { recipients: ["oncall@northwind.example"] }],
      ["webhook", { host: "hooks.northwind.example" }],
    ]);
    expect(doc.auditLog!.length).toBeGreaterThan(0);

    for (const secret of [
      VENDOR_SECRET,
      HOOK_TOKEN,
      RAW_MARKER,
      "whsec_",
      "contoso",
      '"wrappedKey"',
      '"ciphertext"',
    ]) {
      expect(text, secret).not.toContain(secret);
    }
  });

  it("is owners only, once an hour, and written to the audit log before it is sent", async () => {
    const w = await workspace("fabrikam");
    const limiter = createRateLimiter({ limit: 1, windowMs: 3_600_000 });
    expect(await startWorkspaceExport({ db, limiter }, w.tech)).toMatchObject({
      kind: "refused",
      status: 403,
    });

    const first = await startWorkspaceExport({ db, limiter, ip: "203.0.113.9" }, w.owner);
    expect(first).toMatchObject({
      kind: "ok",
      filename: expect.stringMatching(/-export-\d{4}-\d{2}-\d{2}\.json\.gz$/) as string,
    });
    const audit = await db.withTenant(w.tenantId, ({ tx }) =>
      tx.auditLog.findMany({ where: { action: "workspace.exported" } }),
    );
    expect(audit).toMatchObject([{ actorUserId: w.owner.userId, ip: "203.0.113.9" }]);

    expect(await startWorkspaceExport({ db, limiter }, w.owner)).toMatchObject({
      kind: "refused",
      status: 429,
      message: "This workspace was exported in the last hour. Use that file, or try again later.",
    });
    // The technician's refusal did not use up the owner's hour, and limits are per workspace.
    const other = await workspace("tailspin");
    expect(await startWorkspaceExport({ db, limiter }, other.owner)).toMatchObject({ kind: "ok" });
  });

  it("refuses, rather than allowing unlimited exports, when the limit cannot be checked", async () => {
    const w = await workspace("litware");
    const down = { take: () => Promise.reject(new RateLimiterUnavailableError()) };
    expect(await startWorkspaceExport({ db, limiter: down }, w.owner)).toMatchObject({
      kind: "refused",
      status: 503,
    });
  });

  it("downloads as gzip that unpacks to the same document", async () => {
    const w = await workspace("adatum");
    const start = await startWorkspaceExport(
      { db, limiter: createRateLimiter({ limit: 1, windowMs: 1 }) },
      w.owner,
    );
    if (start.kind !== "ok") throw new Error("expected an export");
    const bytes = new Uint8Array(await new Response(gzipStream(start.chunks)).arrayBuffer());
    expect(bytes[0]).toBe(0x1f);
    expect(bytes[1]).toBe(0x8b);
    const doc = JSON.parse(gunzipSync(bytes).toString("utf8")) as { workspace: { name: string } };
    expect(doc.workspace.name).toBe("adatum MSP");
  });
});
