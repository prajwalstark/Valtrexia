import { randomBytes, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import {
  AwsKmsKeyProvider,
  createLogger,
  generateWebhookSecret,
  KeyServiceUnavailableError,
  LocalKeyProvider,
  RotatingKeyProvider,
  Secret,
  type KeyProvider,
} from "@valtrexia/core/server";
import { FakeKms } from "@valtrexia/core/testing/fake-kms";
import {
  createDb,
  createEmailChannel,
  createIntegration,
  createWebhookChannel,
  decryptChannelDestination,
  decryptIntegrationCredentials,
  replaceIntegrationCredentials,
  rewrapRecord,
  type ChannelPreferencesInput,
  type Db,
} from "@valtrexia/db";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { currentKeyId, rotateKeys } from "./rotate";

// Key rotation against a real Postgres: records written under a local key,
// moved to a stand-in AWS KMS key, in two tenants, while other test files
// (whose records are under keys this test does not hold) share the database.

const urls = inject("databaseUrls");
let db: Db;
const logLines: string[] = [];
const logger = createLogger({
  name: "rotate-test",
  level: "debug",
  destination: new Writable({
    write(chunk: Buffer, _encoding, done) {
      logLines.push(chunk.toString());
      done();
    },
  }),
});
beforeAll(() => {
  db = createDb({ url: urls.app });
});
afterAll(async () => {
  await db.disconnect();
});

const PREFS: ChannelPreferencesInput = {
  incidentTypes: ["failed"],
  notifyOpened: true,
  notifyClosed: true,
  notifyIntegrationHealth: true,
};
const SECRET_KEY = "datto-secret-key-must-not-leak-0000";
const HOOK_TOKEN = "hook-path-token-must-not-leak";

/** A tenant with an integration and a webhook under `key`, and an email channel (nothing encrypted). */
async function tenantUnder(key: KeyProvider) {
  const tenantId = await db.provisionTenant({ clerkOrgId: `org_${randomUUID()}`, name: "MSP" });
  return db.withTenant(tenantId, async (context) => {
    const integration = await createIntegration(context, key, {
      vendor: "datto_bcdr",
      name: "Datto",
      credentials: new Secret({ publicKey: "pk-0123", secretKey: SECRET_KEY }),
      actorUserId: null,
    });
    const hook = await createWebhookChannel(context, key, {
      name: "Hook",
      destination: new Secret({
        url: `https://hooks.example.com/${HOOK_TOKEN}`,
        signingSecret: generateWebhookSecret(),
      }),
      preferences: PREFS,
      actorUserId: null,
    });
    await createEmailChannel(context, {
      name: "Email",
      recipients: ["ops@msp.example"],
      preferences: PREFS,
      actorUserId: null,
    });
    return { tenantId, integrationId: integration.id, channelId: hook.id };
  });
}

type Tenant = Awaited<ReturnType<typeof tenantUnder>>;

/** The stored envelopes of a tenant's two encrypted records. */
const stored = (t: Tenant) =>
  db.withTenant(t.tenantId, async ({ tx }) => ({
    integration: (await tx.integration.findUniqueOrThrow({ where: { id: t.integrationId } }))
      .credentialsEnc as Record<string, string>,
    channel: (await tx.notificationChannel.findUniqueOrThrow({ where: { id: t.channelId } }))
      .secretEnc as Record<string, string>,
  }));

/** Reads both records with `key` alone. */
const readWith = async (t: Tenant, key: KeyProvider) => {
  const rows = await db.withTenant(t.tenantId, async ({ tx }) => ({
    integration: await tx.integration.findUniqueOrThrow({ where: { id: t.integrationId } }),
    channel: await tx.notificationChannel.findUniqueOrThrow({ where: { id: t.channelId } }),
  }));
  return {
    credentials: (await decryptIntegrationCredentials(t, key, rows.integration)).expose(),
    url: (await decryptChannelDestination(t, key, rows.channel)).expose().url,
  };
};

function setup() {
  const oldKey = new LocalKeyProvider(randomBytes(32).toString("base64"));
  const kms = new FakeKms();
  kms.createKey(randomUUID(), "valtrexia");
  const kmsOnly = new AwsKmsKeyProvider("arn:aws:kms:eu-west-1:111122223333:alias/valtrexia", kms);
  return { oldKey, kms, kmsOnly, rotating: new RotatingKeyProvider(kmsOnly, [oldKey]) };
}

describe("rotating keys", () => {
  it("moves every record of every tenant to the new key, without re-encrypting the values", async () => {
    const { oldKey, kmsOnly, rotating } = setup();
    const a = await tenantUnder(oldKey);
    const b = await tenantUnder(oldKey);
    const before = { a: await stored(a), b: await stored(b) };

    const summary = await rotateKeys({ db, keyProvider: rotating, logger });
    expect(summary.currentKeyId).toMatch(/^aws-kms:arn:aws:kms:/);
    expect(summary.rewrapped).toBe(4);
    expect(summary.interrupted).toBe(false);
    // Records of other test files are under keys this test does not hold.
    expect(summary.unreadable.filter((r) => [a.tenantId, b.tenantId].includes(r.tenantId))).toEqual(
      [],
    );

    for (const [t, was] of [
      [a, before.a],
      [b, before.b],
    ] as const) {
      const now = await stored(t);
      for (const record of ["integration", "channel"] as const) {
        expect(now[record].keyId).toBe(summary.currentKeyId);
        // The value's own ciphertext is untouched; only the wrapped data key changed.
        expect(now[record]).toMatchObject({
          iv: was[record].iv,
          ciphertext: was[record].ciphertext,
          tag: was[record].tag,
        });
        expect(now[record].wrappedKey).not.toBe(was[record].wrappedKey);
      }
      // The old key is no longer needed.
      expect(await readWith(t, kmsOnly)).toEqual({
        credentials: { publicKey: "pk-0123", secretKey: SECRET_KEY },
        url: `https://hooks.example.com/${HOOK_TOKEN}`,
      });
    }
  });

  it("records each move in the tenant's audit log, as the system, naming the keys only", async () => {
    const { oldKey, rotating } = setup();
    const t = await tenantUnder(oldKey);
    const summary = await rotateKeys({ db, keyProvider: rotating, logger });
    const entries = await db.withTenant(t.tenantId, ({ tx }) =>
      tx.auditLog.findMany({
        where: { action: "encryption.rewrapped" },
        orderBy: { targetType: "asc" },
      }),
    );
    expect(entries).toMatchObject([
      {
        actorType: "system",
        targetType: "integration",
        targetId: t.integrationId,
        metadata: { name: "Datto", fromKeyId: oldKey.keyId, toKeyId: summary.currentKeyId },
      },
      {
        actorType: "system",
        targetType: "notification_channel",
        targetId: t.channelId,
        metadata: { name: "Hook" },
      },
    ]);
  });

  it("changes nothing on a dry run, and nothing on a second run", async () => {
    const { oldKey, rotating } = setup();
    const t = await tenantUnder(oldKey);
    const before = await stored(t);
    const dry = await rotateKeys({ db, keyProvider: rotating, logger }, { dryRun: true });
    expect(dry.examined).toBeGreaterThanOrEqual(2);
    expect(dry.rewrapped).toBe(0);
    expect(await stored(t)).toEqual(before);

    await rotateKeys({ db, keyProvider: rotating, logger });
    const moved = await stored(t);
    const again = await rotateKeys({ db, keyProvider: rotating, logger });
    expect(await stored(t)).toEqual(moved);
    expect(again.unreadable.filter((r) => r.tenantId === t.tenantId)).toEqual([]);
  });

  it("stops when the key service stops answering, and resumes where it left off", async () => {
    const { oldKey, rotating } = setup();
    const t = await tenantUnder(oldKey);
    let wraps = 0;
    // The probe is the first wrap; the record after it finds the service down.
    const flaky: KeyProvider = {
      wrapKey: (key, aad) => {
        wraps += 1;
        return wraps === 3
          ? Promise.reject(new KeyServiceUnavailableError())
          : rotating.wrapKey(key, aad);
      },
      unwrapKey: (wrapped, keyId, aad) => rotating.unwrapKey(wrapped, keyId, aad),
      canUnwrap: (keyId) => rotating.canUnwrap(keyId),
    };
    const first = await rotateKeys({ db, keyProvider: flaky, logger });
    expect(first).toMatchObject({ interrupted: true, rewrapped: 1 });
    const halfway = await stored(t);
    expect([halfway.integration.keyId, halfway.channel.keyId].sort()).toEqual(
      [first.currentKeyId, oldKey.keyId].sort(),
    );

    await rotateKeys({ db, keyProvider: rotating, logger });
    const done = await stored(t);
    expect([done.integration.keyId, done.channel.keyId]).toEqual([
      first.currentKeyId,
      first.currentKeyId,
    ]);
  });

  it("leaves alone a record replaced while it was being re-wrapped", async () => {
    const { oldKey, rotating } = setup();
    const t = await tenantUnder(oldKey);
    const target = await currentKeyId(rotating);
    // Someone replaces the credentials between the read and the write.
    const racing: KeyProvider = {
      wrapKey: async (key, aad) => {
        await db.withTenant(t.tenantId, (context) =>
          replaceIntegrationCredentials(context, rotating, {
            id: t.integrationId,
            credentials: new Secret({ publicKey: "pk-new", secretKey: "sk-new-0000000000" }),
            credentialHint: "-new",
            actorUserId: null,
          }),
        );
        return rotating.wrapKey(key, aad);
      },
      unwrapKey: (wrapped, keyId, aad) => rotating.unwrapKey(wrapped, keyId, aad),
      canUnwrap: (keyId) => rotating.canUnwrap(keyId),
    };
    expect(
      await rewrapRecord(db, racing, { ...t, type: "integration", id: t.integrationId }, target),
    ).toEqual({ outcome: "changed", fromKeyId: oldKey.keyId });
    expect((await readWith(t, rotating)).credentials).toEqual({
      publicKey: "pk-new",
      secretKey: "sk-new-0000000000",
    });
    expect(
      await rewrapRecord(db, rotating, { ...t, type: "integration", id: t.integrationId }, target),
    ).toEqual({ outcome: "current" });
  });

  it("reports a record no configured key can read, by id, and moves the rest", async () => {
    const { oldKey, rotating } = setup();
    const lost = new LocalKeyProvider(randomBytes(32).toString("base64"));
    const readable = await tenantUnder(oldKey);
    const unreadable = await tenantUnder(lost);
    const summary = await rotateKeys({ db, keyProvider: rotating, logger });
    expect(summary.unreadable.filter((r) => r.tenantId === unreadable.tenantId)).toEqual(
      expect.arrayContaining([
        { tenantId: unreadable.tenantId, type: "integration", id: unreadable.integrationId },
        { tenantId: unreadable.tenantId, type: "notification_channel", id: unreadable.channelId },
      ]),
    );
    expect(summary.remaining.find((r) => r.keyId === lost.keyId)?.records).toBe(2);
    expect((await stored(readable)).integration.keyId).toBe(summary.currentKeyId);
    expect((await stored(unreadable)).integration.keyId).toBe(lost.keyId);
  });

  it("logs no credential, destination or wrapped key", async () => {
    const { oldKey, rotating } = setup();
    const t = await tenantUnder(oldKey);
    const before = await stored(t);
    logLines.length = 0;
    await rotateKeys({ db, keyProvider: rotating, logger });
    const log = logLines.join("\n");
    for (const secret of [SECRET_KEY, HOOK_TOKEN, before.integration.wrappedKey!]) {
      expect(log).not.toContain(secret);
    }
  });
});
