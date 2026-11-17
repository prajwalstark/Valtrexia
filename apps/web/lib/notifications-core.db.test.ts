import { randomBytes, randomUUID } from "node:crypto";
import { LocalKeyProvider, type Resolver } from "@valtrexia/core/server";
import { createDb, decryptChannelDestination, type Db } from "@valtrexia/db";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  createWebhookChannelFor,
  deleteChannelFor,
  listChannelsFor,
  sendTestNotificationFor,
  type NotificationDeps,
} from "./notifications-core";
import type { TenantSession } from "./session-core";

const urls = inject("databaseUrls");
const IP = "203.0.113.9";
const NOW = new Date("2026-11-12T15:00:00Z");

let db: Db;
const keyProvider = new LocalKeyProvider(randomBytes(32).toString("base64"));
beforeAll(() => {
  db = createDb({ url: urls.app });
});
afterAll(async () => {
  await db.disconnect();
});

/** DNS for the tests: a few public names, one that points inside the network. */
const resolver: Resolver = async (hostname) => {
  const table: Record<string, string> = {
    "hooks.example.com": "93.184.216.34",
    "evil.example.com": "10.0.0.8",
  };
  const address = table[hostname];
  if (!address) throw new Error("ENOTFOUND");
  return [{ address, family: 4 }];
};
const deps = (): NotificationDeps => ({
  db,
  keyProvider,
  outboundPolicy: {},
  ip: IP,
  resolver,
  now: NOW,
});

async function workspace() {
  const tenantId = await db.provisionTenant({
    clerkOrgId: `org_${randomUUID()}`,
    name: "Northwind IT",
  });
  return db.withTenant(tenantId, async ({ tx }) => {
    const user = async (role: "owner" | "technician") => {
      const row = await tx.user.create({
        data: { tenantId, clerkUserId: `user_${randomUUID()}`, email: `${role}@msp.example`, role },
      });
      return {
        tenantId,
        userId: row.id,
        clerkUserId: row.clerkUserId,
        role,
      } satisfies TenantSession;
    };
    return { tenantId, owner: await user("owner"), tech: await user("technician") };
  });
}

const valid = {
  name: "Ops webhook",
  url: "https://hooks.example.com/in/T0K3N?team=ops",
  incidentTypes: ["failed", "missed"],
  notifyOpened: "on",
  notifyClosed: null,
  notifyIntegrationHealth: "on",
};

describe("createWebhookChannelFor", () => {
  it("creates the channel, stores the destination encrypted, and hands back the secret once", async () => {
    const w = await workspace();
    const state = await createWebhookChannelFor(deps(), w.owner, valid);
    expect(state).toMatchObject({
      status: "ok",
      channelId: expect.any(String) as string,
      signingSecret: expect.stringMatching(/^whsec_/) as string,
    });
    if (state.status !== "ok") throw new Error("expected ok");

    const [channel] = await listChannelsFor({ db }, w.tech);
    expect(channel).toMatchObject({
      id: state.channelId,
      type: "webhook",
      name: "Ops webhook",
      enabled: true,
      incidentTypes: ["failed", "missed"],
      notifyOpened: true,
      notifyClosed: false,
      notifyIntegrationHealth: true,
      config: { host: "hooks.example.com" },
    });
    // What anyone can list holds neither the path, its token, nor the secret.
    const listed = JSON.stringify(await listChannelsFor({ db }, w.tech));
    expect(listed).not.toContain("T0K3N");
    expect(listed).not.toContain(state.signingSecret);

    // The row holds an envelope, not the URL; only the key provider opens it.
    const row = await db.withTenant(w.tenantId, ({ tx }) =>
      tx.notificationChannel.findUniqueOrThrow({ where: { id: state.channelId! } }),
    );
    expect(JSON.stringify(row.secretEnc)).not.toContain("T0K3N");
    const destination = await decryptChannelDestination({ tenantId: w.tenantId }, keyProvider, row);
    expect(destination.expose()).toEqual({
      url: "https://hooks.example.com/in/T0K3N?team=ops",
      signingSecret: state.signingSecret,
    });
  });

  it("audits the creation with the host, never the path or the secret", async () => {
    const w = await workspace();
    const state = await createWebhookChannelFor(deps(), w.owner, valid);
    const entries = await db.withTenant(w.tenantId, ({ tx }) => tx.auditLog.findMany());
    expect(entries).toMatchObject([
      {
        action: "notification_channel.created",
        actorUserId: w.owner.userId,
        ip: IP,
        metadata: { type: "webhook", name: "Ops webhook", host: "hooks.example.com" },
      },
    ]);
    const text = JSON.stringify(entries);
    expect(text).not.toContain("T0K3N");
    if (state.status === "ok") expect(text).not.toContain(state.signingSecret);
  });

  it("is for owners only", async () => {
    const w = await workspace();
    expect(await createWebhookChannelFor(deps(), w.tech, valid)).toEqual({
      status: "error",
      message: "Only workspace owners can manage notification channels.",
    });
    expect(await listChannelsFor({ db }, w.owner)).toEqual([]);
  });

  it.each([
    ["http://hooks.example.com/in", "The URL must start with https://."],
    ["https://user:pw@hooks.example.com/in", "The URL must not contain a user name or password."],
    [
      "https://10.0.0.8/in",
      "The URL must point to a public address, not a private or internal one.",
    ],
    [
      "https://169.254.169.254/latest",
      "The URL must point to a public address, not a private or internal one.",
    ],
    [
      "https://evil.example.com/in",
      "The URL must point to a public address, not a private or internal one.",
    ],
    ["https://nowhere.example.com/in", "The URL's host name could not be found."],
    ["https://hooks.example.com:22/in", "The URL's port must be 443, or 1024 or above."],
    ["not a url", "That is not a valid URL."],
    ["", "Enter the URL to send to."],
  ])("refuses %s", async (url, message) => {
    const w = await workspace();
    const state = await createWebhookChannelFor(deps(), w.owner, { ...valid, url });
    expect(state).toMatchObject({ status: "error", fieldErrors: { url: message } });
    expect(await listChannelsFor({ db }, w.owner)).toEqual([]);
  });

  it("needs a name, unique in the workspace, and at least one kind of incident", async () => {
    const w = await workspace();
    expect(await createWebhookChannelFor(deps(), w.owner, { ...valid, name: "  " })).toMatchObject({
      fieldErrors: { name: expect.any(String) as string },
    });
    expect(
      await createWebhookChannelFor(deps(), w.owner, { ...valid, incidentTypes: [] }),
    ).toMatchObject({ fieldErrors: { incidentTypes: "Choose at least one kind of incident." } });
    expect(
      await createWebhookChannelFor(deps(), w.owner, { ...valid, incidentTypes: ["exploded"] }),
    ).toMatchObject({ fieldErrors: { incidentTypes: "Choose at least one kind of incident." } });

    expect((await createWebhookChannelFor(deps(), w.owner, valid)).status).toBe("ok");
    expect(await createWebhookChannelFor(deps(), w.owner, valid)).toMatchObject({
      fieldErrors: { name: "A channel with this name already exists." },
    });
  });

  it("makes a different secret for every channel", async () => {
    const w = await workspace();
    const one = await createWebhookChannelFor(deps(), w.owner, valid);
    const two = await createWebhookChannelFor(deps(), w.owner, { ...valid, name: "Second" });
    if (one.status !== "ok" || two.status !== "ok") throw new Error("expected ok");
    expect(one.signingSecret).not.toBe(two.signingSecret);
  });
});

describe("deleteChannelFor and sendTestNotificationFor", () => {
  it("queues a test message, owners only", async () => {
    const w = await workspace();
    const created = await createWebhookChannelFor(deps(), w.owner, valid);
    if (created.status !== "ok") throw new Error("expected ok");

    expect((await sendTestNotificationFor(deps(), w.tech, created.channelId!)).status).toBe(
      "error",
    );
    expect(await sendTestNotificationFor(deps(), w.owner, created.channelId!)).toMatchObject({
      status: "ok",
    });
    const batches = await db.withTenant(w.tenantId, ({ tx }) => tx.notificationBatch.findMany());
    expect(batches).toMatchObject([
      {
        kind: "test",
        status: "pending",
        payload: { type: "test", data: { workspace: { name: "Northwind IT" } } },
      },
    ]);
  });

  it("deletes a channel with everything queued for it, and audits it", async () => {
    const w = await workspace();
    const created = await createWebhookChannelFor(deps(), w.owner, valid);
    if (created.status !== "ok") throw new Error("expected ok");
    await sendTestNotificationFor(deps(), w.owner, created.channelId!);

    expect((await deleteChannelFor(deps(), w.tech, created.channelId!)).status).toBe("error");
    expect(await deleteChannelFor(deps(), w.owner, created.channelId!)).toEqual({
      status: "ok",
      message: "Channel deleted.",
    });
    expect(await listChannelsFor({ db }, w.owner)).toEqual([]);
    expect(await db.withTenant(w.tenantId, ({ tx }) => tx.notificationBatch.count())).toBe(0);
    const actions = (await db.withTenant(w.tenantId, ({ tx }) => tx.auditLog.findMany())).map(
      (e) => e.action,
    );
    expect(actions).toContain("notification_channel.deleted");
  });

  it("cannot touch another workspace's channel", async () => {
    const mine = await workspace();
    const theirs = await workspace();
    const created = await createWebhookChannelFor(deps(), theirs.owner, valid);
    if (created.status !== "ok") throw new Error("expected ok");

    expect(await deleteChannelFor(deps(), mine.owner, created.channelId!)).toEqual({
      status: "error",
      message: "That channel no longer exists.",
    });
    expect(await sendTestNotificationFor(deps(), mine.owner, created.channelId!)).toEqual({
      status: "error",
      message: "That channel no longer exists.",
    });
    expect(await listChannelsFor({ db }, mine.owner)).toEqual([]);
    expect(await listChannelsFor({ db }, theirs.owner)).toHaveLength(1);
  });
});
