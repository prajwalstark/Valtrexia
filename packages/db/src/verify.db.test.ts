import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  generateWebhookSecret,
  LocalKeyProvider,
  RotatingKeyProvider,
  Secret,
  type KeyProvider,
} from "@valtrexia/core/server";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  createDb,
  createIntegration,
  createWebhookChannel,
  migrationNames,
  verifyDatabase,
  type Db,
  type VerifyCheck,
} from "./index";

// The restore drill, for real: a database is migrated and given a
// workspace, dumped with pg_dump, restored with pg_restore into an empty
// database, and checked as the app would see it. Then the restored copy is
// damaged one way at a time, and each must be caught with a clear reason.

const run = promisify(execFile);
const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const urls = inject("databaseUrls");
const base = new URL(urls.owner).pathname.slice(1);
const SOURCE = `${base}_drill_source`;
const RESTORED = `${base}_drill_restored`;
const withDatabase = (url: string, name: string) => {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
};

const key = new LocalKeyProvider(randomBytes(32).toString("base64"));
const expectedMigrations = migrationNames();
let admin: pg.Client;
let restoredOwner: pg.Client;
let restoredApp: pg.Client;
let sourceDb: Db;
let workDir: string;
let integrationId: string;

async function dropDatabase(name: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

const verify = (client: pg.Client, keyProvider: KeyProvider = key) =>
  verifyDatabase({ client, expectedMigrations, keyProvider });
const byName = (checks: VerifyCheck[]) => Object.fromEntries(checks.map((c) => [c.name, c]));

beforeAll(async () => {
  admin = new pg.Client({ connectionString: urls.owner });
  await admin.connect();
  for (const name of [SOURCE, RESTORED]) {
    await dropDatabase(name);
    await admin.query(`CREATE DATABASE ${name}`);
  }
  const prismaCli = createRequire(join(packageDir, "package.json")).resolve(
    "prisma/build/index.js",
  );
  await run(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: packageDir,
    env: { ...process.env, DATABASE_URL_OWNER: withDatabase(urls.owner, SOURCE) },
  });

  // A workspace with a vendor connection and a webhook, both encrypted.
  sourceDb = createDb({ url: withDatabase(urls.app, SOURCE), maxConnections: 2 });
  const tenantId = await sourceDb.provisionTenant({
    clerkOrgId: `org_${randomUUID()}`,
    name: "MSP",
  });
  await sourceDb.withTenant(tenantId, async (context) => {
    integrationId = (
      await createIntegration(context, key, {
        vendor: "mock",
        name: "Demo",
        credentials: new Secret({ seed: "drill" }),
        actorUserId: null,
      })
    ).id;
    await createWebhookChannel(context, key, {
      name: "Hook",
      destination: new Secret({
        url: "https://hooks.example.com/x",
        signingSecret: generateWebhookSecret(),
      }),
      preferences: {
        incidentTypes: ["failed"],
        notifyOpened: true,
        notifyClosed: true,
        notifyIntegrationHealth: true,
        notifyMonthlyReport: true,
      },
      actorUserId: null,
    });
  });
  await sourceDb.disconnect();

  // The drill: dump, then restore into an empty database.
  workDir = mkdtempSync(join(tmpdir(), "valtrexia-drill-"));
  const dump = join(workDir, "backup.dump");
  await run("pg_dump", [
    "--format=custom",
    `--file=${dump}`,
    `--dbname=${withDatabase(urls.owner, SOURCE)}`,
  ]);
  await run("pg_restore", [
    "--no-owner",
    "--exit-on-error",
    `--dbname=${withDatabase(urls.owner, RESTORED)}`,
    dump,
  ]);

  restoredOwner = new pg.Client({ connectionString: withDatabase(urls.owner, RESTORED) });
  restoredApp = new pg.Client({ connectionString: withDatabase(urls.app, RESTORED) });
  await restoredOwner.connect();
  await restoredApp.connect();
}, 120_000);

afterAll(async () => {
  await restoredApp?.end();
  await restoredOwner?.end();
  for (const name of [SOURCE, RESTORED]) await dropDatabase(name);
  await admin.end();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/** Applies damage as the owner, checks as the app, then undoes it. */
async function withDamage(
  damage: string,
  undo: string,
  assert: (checks: Record<string, VerifyCheck>) => void,
) {
  await restoredOwner.query(damage);
  try {
    assert(byName(await verify(restoredApp)));
  } finally {
    await restoredOwner.query(undo);
  }
}

describe("restore drill", () => {
  it("passes every check on a database restored from a dump", async () => {
    const checks = await verify(restoredApp);
    expect(checks.map((c) => [c.name, c.ok])).toEqual([
      ["migrations", true],
      ["isolation", true],
      ["role", true],
      ["functions", true],
      ["encryption", true],
    ]);
    expect(byName(checks).migrations!.detail).toBe(
      `all ${expectedMigrations.length} migrations applied`,
    );
    expect(byName(checks).encryption!.detail).toBe(
      "2 encrypted records under 1 key; one per key decrypted",
    );
  });

  it("fails when this server does not have the key the records were written with", async () => {
    const other = new LocalKeyProvider(randomBytes(32).toString("base64"));
    const { encryption } = byName(await verify(restoredApp, other));
    expect(encryption).toMatchObject({ ok: false });
    expect(encryption!.detail).toBe(
      `records under keys this server does not have: 2 under ${key.keyId}`,
    );
    // During a rotation, with the old key still configured, it passes.
    expect(
      byName(await verify(restoredApp, new RotatingKeyProvider(other, [key]))).encryption!.ok,
    ).toBe(true);
  });

  it("fails when connected as anything but the runtime role", async () => {
    const { role } = byName(await verify(restoredOwner));
    expect(role!.ok).toBe(false);
    expect(role!.detail).toMatch(/^connected as \w+, not valtrexia_app: check DATABASE_URL$/);
  });

  it("names a tenant table left without row-level security", async () => {
    await withDamage(
      "ALTER TABLE assets DISABLE ROW LEVEL SECURITY",
      "ALTER TABLE assets ENABLE ROW LEVEL SECURITY",
      ({ isolation }) => {
        expect(isolation).toMatchObject({
          ok: false,
          detail: "without row-level security or a policy: assets",
        });
      },
    );
  });

  it("names a cross-tenant function opened to everyone, or closed to the app", async () => {
    await withDamage(
      "GRANT EXECUTE ON FUNCTION purge_due_tenants(integer) TO PUBLIC",
      "REVOKE EXECUTE ON FUNCTION purge_due_tenants(integer) FROM PUBLIC",
      ({ functions }) => {
        expect(functions).toMatchObject({
          ok: false,
          detail: "purge_due_tenants is executable by everyone",
        });
      },
    );
    await withDamage(
      "REVOKE EXECUTE ON FUNCTION apply_retention(integer, integer, integer, integer) FROM valtrexia_app",
      "GRANT EXECUTE ON FUNCTION apply_retention(integer, integer, integer, integer) TO valtrexia_app",
      ({ functions }) => {
        expect(functions!.detail).toBe("apply_retention is not executable by valtrexia_app");
      },
    );
  });

  it("names a migration that did not run, and one this codebase does not know", async () => {
    const last = expectedMigrations[expectedMigrations.length - 1]!;
    await withDamage(
      `UPDATE _prisma_migrations SET rolled_back_at = now() WHERE migration_name = '${last}'`,
      `UPDATE _prisma_migrations SET rolled_back_at = NULL WHERE migration_name = '${last}'`,
      ({ migrations }) => {
        expect(migrations).toMatchObject({ ok: false, detail: `not applied: ${last}` });
      },
    );
    await withDamage(
      `INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, finished_at, applied_steps_count)
       VALUES ('drill', 'x', '29991231000000_from_the_future', now(), now(), 1)`,
      "DELETE FROM _prisma_migrations WHERE id = 'drill'",
      ({ migrations }) => {
        expect(migrations!.detail).toBe(
          "applied but not in this codebase: 29991231000000_from_the_future",
        );
      },
    );
  });

  it("fails when a record's ciphertext was damaged", async () => {
    const { rows } = await restoredOwner.query<{ credentials_enc: { ciphertext: string } }>(
      "SELECT credentials_enc FROM integrations WHERE id = $1",
      [integrationId],
    );
    const original = JSON.stringify(rows[0]!.credentials_enc);
    const damaged = JSON.stringify({
      ...rows[0]!.credentials_enc,
      ciphertext: Buffer.from("garbage").toString("base64"),
    });
    // The channel is sampled first if it sorts first; damage both to be sure.
    const { rows: channels } = await restoredOwner.query<{ id: string; secret_enc: object }>(
      "SELECT id, secret_enc FROM notification_channels",
    );
    const channel = channels[0]!;
    const damagedChannel = JSON.stringify({
      ...channel.secret_enc,
      ciphertext: Buffer.from("garbage").toString("base64"),
    });
    await restoredOwner.query("UPDATE notification_channels SET secret_enc = $1 WHERE id = $2", [
      damagedChannel,
      channel.id,
    ]);
    try {
      await withDamage(
        `UPDATE integrations SET credentials_enc = '${damaged.replace(/'/g, "''")}' WHERE id = '${integrationId}'`,
        `UPDATE integrations SET credentials_enc = '${original.replace(/'/g, "''")}' WHERE id = '${integrationId}'`,
        ({ encryption }) => {
          expect(encryption!.ok).toBe(false);
          expect(encryption!.detail).toMatch(
            /^a record under local:\w+ did not decrypt \((integration|notification_channel) [0-9a-f-]{36}\)$/,
          );
        },
      );
    } finally {
      await restoredOwner.query("UPDATE notification_channels SET secret_enc = $1 WHERE id = $2", [
        JSON.stringify(channel.secret_enc),
        channel.id,
      ]);
    }
    // Repaired, it passes again.
    expect((await verify(restoredApp)).every((check) => check.ok)).toBe(true);
  });

  it("refuses an empty database unless told it is a new deployment", async () => {
    // The same database, with the count of encrypted records made empty.
    const emptyView = {
      query: ((sql: string, params?: unknown[]) =>
        sql.includes("count_encrypted_records_by_key")
          ? Promise.resolve({ rows: [] })
          : restoredApp.query(sql, params)) as pg.Client["query"],
    };
    const refused = await verifyDatabase({
      client: emptyView,
      expectedMigrations,
      keyProvider: key,
    });
    expect(byName(refused).encryption).toMatchObject({
      ok: false,
      detail: "no encrypted records to try; a restored production database should have some",
    });
    const allowed = await verifyDatabase({
      client: emptyView,
      expectedMigrations,
      keyProvider: key,
      allowNoRecords: true,
    });
    expect(allowed.every((check) => check.ok)).toBe(true);
  });
});
