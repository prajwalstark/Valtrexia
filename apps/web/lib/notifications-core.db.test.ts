import { randomBytes, randomUUID } from "node:crypto";
import { LocalKeyProvider, type Resolver } from "@valtrexia/core/server";
import { createDb, decryptChannelDestination, type Db } from "@valtrexia/db";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  createEmailChannelFor,
  createWebhookChannelFor,
  deleteChannelFor,
  getNotificationsPage,
  listChannelsFor,
  parseRecipients,
  sendTestNotificationFor,
  setChannelEnabledFor,
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

describe("parseRecipients", () => {
  it("reads addresses separated however people type them, dropping repeats", () => {
    expect(
      parseRecipients("alex@msp.example, sam@msp.example;\nKim@msp.example  ALEX@msp.example"),
    ).toEqual({
      ok: true,
      recipients: ["alex@msp.example", "sam@msp.example", "Kim@msp.example"],
    });
  });

  it.each([
    ["", "Enter at least one email address."],
    [" , ; ", "Enter at least one email address."],
    ["alex@msp.example, not-an-address", "not-an-address is not an email address."],
    ["alex@", "alex@ is not an email address."],
    [null, "Enter at least one email address."],
  ])("refuses %j", (value, message) => {
    expect(parseRecipients(value)).toEqual({ ok: false, message });
  });

  it("allows up to 20 addresses", () => {
    const list = (n: number) => Array.from({ length: n }, (_, i) => `p${i}@msp.example`).join(",");
    expect(parseRecipients(list(20))).toMatchObject({ ok: true });
    expect(parseRecipients(list(21))).toEqual({
      ok: false,
      message: "Up to 20 addresses per channel.",
    });
  });
});

describe("createEmailChannelFor", () => {
  const email = {
    name: "On-call",
    recipients: "alex@msp.example, sam@msp.example",
    incidentTypes: ["failed", "missed", "stale"],
    notifyOpened: "on",
    notifyClosed: "on",
    notifyIntegrationHealth: "on",
  };
  const emailDeps = (emailAvailable = true) => ({ db, ip: IP, emailAvailable });

  it("creates the channel with its recipients visible, and audits how many", async () => {
    const w = await workspace();
    const state = await createEmailChannelFor(emailDeps(), w.owner, email);
    expect(state).toMatchObject({ status: "ok", message: "Channel created." });
    expect(state).not.toHaveProperty("signingSecret");
    const [channel] = await listChannelsFor({ db }, w.tech);
    expect(channel).toMatchObject({
      type: "email",
      name: "On-call",
      config: { recipients: ["alex@msp.example", "sam@msp.example"] },
    });
    const [entry] = await db.withTenant(w.tenantId, ({ tx }) => tx.auditLog.findMany());
    expect(entry).toMatchObject({
      action: "notification_channel.created",
      metadata: { type: "email", name: "On-call", recipients: 2 },
    });
  });

  it("is refused when this server has no email set up, and for technicians", async () => {
    const w = await workspace();
    expect(await createEmailChannelFor(emailDeps(false), w.owner, email)).toEqual({
      status: "error",
      message: "Email is not set up on this server yet.",
    });
    expect((await createEmailChannelFor(emailDeps(), w.tech, email)).status).toBe("error");
    expect(await listChannelsFor({ db }, w.owner)).toEqual([]);
  });

  it("checks its fields, and shares the name space with webhooks", async () => {
    const w = await workspace();
    expect(
      await createEmailChannelFor(emailDeps(), w.owner, { ...email, recipients: "nope" }),
    ).toMatchObject({ fieldErrors: { recipients: "nope is not an email address." } });
    await createWebhookChannelFor(deps(), w.owner, { ...valid, name: "On-call" });
    expect(await createEmailChannelFor(emailDeps(), w.owner, email)).toMatchObject({
      fieldErrors: { name: "A channel with this name already exists." },
    });
  });
});

describe("setChannelEnabledFor and getNotificationsPage", () => {
  it("turns a channel off and on, auditing each change once", async () => {
    const w = await workspace();
    const created = await createWebhookChannelFor(deps(), w.owner, valid);
    if (created.status !== "ok") throw new Error("expected ok");
    const id = created.channelId!;

    expect((await setChannelEnabledFor(deps(), w.tech, id, false)).status).toBe("error");
    expect(await setChannelEnabledFor(deps(), w.owner, id, false)).toEqual({
      status: "ok",
      message: "Channel turned off.",
    });
    expect(await setChannelEnabledFor(deps(), w.owner, id, false)).toMatchObject({ status: "ok" });
    expect((await listChannelsFor({ db }, w.owner))[0]!.enabled).toBe(false);
    await setChannelEnabledFor(deps(), w.owner, id, true);
    const actions = (
      await db.withTenant(w.tenantId, ({ tx }) =>
        tx.auditLog.findMany({ orderBy: { createdAt: "asc" } }),
      )
    ).map((entry) => entry.action);
    expect(actions).toEqual([
      "notification_channel.created",
      "notification_channel.disabled",
      "notification_channel.enabled",
    ]);
  });

  it("lists each channel with its recent messages, and nothing secret", async () => {
    const w = await workspace();
    const created = await createWebhookChannelFor(deps(), w.owner, valid);
    if (created.status !== "ok") throw new Error("expected ok");
    for (let i = 0; i < 7; i += 1)
      await sendTestNotificationFor(deps(), w.owner, created.channelId!);

    const page = await getNotificationsPage({ db }, w.tech);
    expect(page.timeZone).toBe("UTC");
    expect(page.channels).toHaveLength(1);
    expect(page.channels[0]!.recent).toHaveLength(5);
    expect(page.channels[0]!.recent[0]).toMatchObject({
      kind: "test",
      status: "pending",
      attempts: 0,
    });
    const text = JSON.stringify(page);
    expect(text).not.toContain("T0K3N");
    expect(text).not.toContain(created.signingSecret);
    expect(text).not.toContain("secretEnc");
  });

  it("refuses another workspace's channel", async () => {
    const mine = await workspace();
    const theirs = await workspace();
    const created = await createWebhookChannelFor(deps(), theirs.owner, valid);
    if (created.status !== "ok") throw new Error("expected ok");
    expect(await setChannelEnabledFor(deps(), mine.owner, created.channelId!, false)).toEqual({
      status: "error",
      message: "That channel no longer exists.",
    });
    expect((await listChannelsFor({ db }, theirs.owner))[0]!.enabled).toBe(true);
  });
});
