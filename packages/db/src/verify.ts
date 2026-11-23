import {
  decryptJson,
  KeyServiceUnavailableError,
  type EncryptionContext,
  type KeyProvider,
} from "@valtrexia/core/server";
import type pg from "pg";
import { APP_ROLE, DEFINER_FUNCTIONS, DEFINER_SEARCH_PATH } from "./catalog";

/**
 * Checks that a database (typically one just restored from a backup) is
 * safe to serve from, connected as the runtime role exactly as the app will
 * be. Five checks, all of which must pass:
 *
 *  1. migrations   Every migration in this codebase has run, and no other.
 *  2. isolation    Row-level security is on, with a policy, for every table
 *                  holding tenant data.
 *  3. role         The connection is the runtime role, which cannot bypass
 *                  row-level security, is not a superuser and owns nothing.
 *  4. functions    The cross-tenant functions are exactly the expected ones,
 *                  each pinned and executable by the runtime role only.
 *  5. encryption   Every key the stored credentials are wrapped under is one
 *                  this server can use, and one record per key decrypts.
 *
 * Reports names, counts and key ids; never a credential or a tenant's data.
 */

export interface VerifyCheck {
  name: "migrations" | "isolation" | "role" | "functions" | "encryption";
  ok: boolean;
  /** One line: what was found. Names and counts only. */
  detail: string;
}

export interface VerifyOptions {
  /** A client connected with the URL the app will use. */
  client: Pick<pg.ClientBase, "query">;
  /** The migrations this codebase has: `migrationNames()`. */
  expectedMigrations: readonly string[];
  keyProvider: KeyProvider;
  /**
   * Pass the encryption check when there is nothing encrypted to try. For a
   * new, empty deployment; a restored production database always has some.
   */
  allowNoRecords?: boolean;
}

export async function verifyDatabase(options: VerifyOptions): Promise<VerifyCheck[]> {
  const { client } = options;
  const checks: VerifyCheck[] = [];
  const run = async (
    name: VerifyCheck["name"],
    check: () => Promise<Omit<VerifyCheck, "name">>,
  ) => {
    try {
      checks.push({ name, ...(await check()) });
    } catch (error) {
      // A check that cannot run has not passed. Postgres's message names
      // objects, not data; keep its first line only.
      const reason =
        error instanceof Error ? error.message.split("\n")[0]!.slice(0, 200) : "unknown error";
      checks.push({ name, ok: false, detail: `could not be checked: ${reason}` });
    }
  };

  await run("migrations", async () => {
    const { rows } = await client.query<{ migration_name: string }>(
      "SELECT migration_name FROM applied_migrations()",
    );
    const applied = new Set(rows.map((row) => row.migration_name));
    const expected = new Set(options.expectedMigrations);
    const missing = [...expected].filter((name) => !applied.has(name));
    const unknown = [...applied].filter((name) => !expected.has(name));
    if (missing.length === 0 && unknown.length === 0) {
      return { ok: true, detail: `all ${expected.size} migrations applied` };
    }
    return {
      ok: false,
      detail: [
        missing.length > 0 ? `not applied: ${missing.join(", ")}` : null,
        unknown.length > 0 ? `applied but not in this codebase: ${unknown.join(", ")}` : null,
      ]
        .filter(Boolean)
        .join("; "),
    };
  });

  await run("isolation", async () => {
    const { rows } = await client.query<{ relname: string; rls: boolean; policies: number }>(`
      SELECT c.relname, c.relrowsecurity AS rls,
             (SELECT count(*)::int FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        AND (c.relname = 'tenants' OR EXISTS (
          SELECT 1 FROM pg_catalog.pg_attribute a
          WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
        ))
      ORDER BY c.relname
    `);
    const unprotected = rows
      .filter((row) => !row.rls || row.policies === 0)
      .map((row) => row.relname);
    if (rows.length < 2) return { ok: false, detail: "no tenant tables found" };
    return unprotected.length === 0
      ? { ok: true, detail: `row-level security on all ${rows.length} tenant tables` }
      : { ok: false, detail: `without row-level security or a policy: ${unprotected.join(", ")}` };
  });

  await run("role", async () => {
    const { rows } = await client.query<RoleFacts>(
      `SELECT current_user AS connected_as,
              r.rolsuper AS superuser, r.rolbypassrls AS bypass_rls,
              (SELECT count(*)::int FROM pg_catalog.pg_class c
                 JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = 'public' AND c.relowner = r.oid) AS owned
       FROM pg_catalog.pg_roles r WHERE r.rolname = $1`,
      [APP_ROLE],
    );
    const problems = roleProblems(rows[0]);
    return problems.length === 0
      ? { ok: true, detail: `connected as ${APP_ROLE}, which cannot bypass row-level security` }
      : { ok: false, detail: problems.join("; ") };
  });

  await run("functions", async () => {
    const { rows } = await client.query<{
      proname: string;
      proconfig: string[] | null;
      public_can_execute: boolean;
      app_can_execute: boolean;
    }>(
      `SELECT p.proname, p.proconfig,
              EXISTS (
                SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
                WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
              ) AS public_can_execute,
              has_function_privilege($1, p.oid, 'EXECUTE') AS app_can_execute
       FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prosecdef
       ORDER BY p.proname`,
      [APP_ROLE],
    );
    const found = new Set(rows.map((row) => row.proname));
    const problems: string[] = [];
    const missing = DEFINER_FUNCTIONS.filter((name) => !found.has(name));
    const extra = [...found].filter(
      (name) => !(DEFINER_FUNCTIONS as readonly string[]).includes(name),
    );
    if (missing.length > 0) problems.push(`missing: ${missing.join(", ")}`);
    if (extra.length > 0) problems.push(`not expected: ${extra.join(", ")}`);
    for (const row of rows) {
      if (!(row.proconfig ?? []).includes(DEFINER_SEARCH_PATH))
        problems.push(`${row.proname} does not pin search_path`);
      if (row.public_can_execute) problems.push(`${row.proname} is executable by everyone`);
      if (!row.app_can_execute) problems.push(`${row.proname} is not executable by ${APP_ROLE}`);
    }
    return problems.length === 0
      ? {
          ok: true,
          detail: `all ${DEFINER_FUNCTIONS.length} cross-tenant functions present and locked down`,
        }
      : { ok: false, detail: problems.join("; ") };
  });

  await run("encryption", () => checkEncryption(options));
  return checks;
}

interface RoleFacts {
  connected_as: string;
  superuser: boolean;
  bypass_rls: boolean;
  owned: number;
}

/** What is wrong with the runtime role, from the facts read about it. Empty when nothing. */
export function roleProblems(facts: RoleFacts | undefined): string[] {
  if (!facts) return [`the role ${APP_ROLE} does not exist`];
  const problems: string[] = [];
  if (facts.connected_as !== APP_ROLE) {
    problems.push(`connected as ${facts.connected_as}, not ${APP_ROLE}: check DATABASE_URL`);
  }
  if (facts.superuser) problems.push(`${APP_ROLE} is a superuser`);
  if (facts.bypass_rls) problems.push(`${APP_ROLE} can bypass row-level security`);
  if (facts.owned > 0) problems.push(`${APP_ROLE} owns ${facts.owned} tables`);
  return problems;
}

async function checkEncryption(options: VerifyOptions): Promise<Omit<VerifyCheck, "name">> {
  const { client, keyProvider } = options;
  const { rows: byKey } = await client.query<{
    record_type: string;
    key_id: string | null;
    records: string;
  }>("SELECT record_type, key_id, records FROM count_encrypted_records_by_key()");
  const keyIds = [...new Set(byKey.map((row) => row.key_id))];
  const total = byKey.reduce((sum, row) => sum + Number(row.records), 0);
  if (total === 0) {
    return options.allowNoRecords
      ? { ok: true, detail: "no encrypted records to try (allowed for an empty database)" }
      : {
          ok: false,
          detail: "no encrypted records to try; a restored production database should have some",
        };
  }

  const unusable = keyIds.filter((keyId) => keyId === null || !keyProvider.canUnwrap(keyId));
  if (unusable.length > 0) {
    const counts = unusable.map((keyId) => {
      const n = byKey
        .filter((row) => row.key_id === keyId)
        .reduce((s, r) => s + Number(r.records), 0);
      return `${n} under ${keyId ?? "no key"}`;
    });
    return {
      ok: false,
      detail: `records under keys this server does not have: ${counts.join(", ")}`,
    };
  }

  // One record per key: proof the key really unwraps, not just that its id is known.
  for (const keyId of keyIds as string[]) {
    const sample = await sampleUnder(client, keyId);
    if (!sample) return { ok: false, detail: `no readable record found under ${keyId}` };
    try {
      await decryptJson(sample.envelope, sample.context, keyProvider);
    } catch (error) {
      if (error instanceof KeyServiceUnavailableError) {
        return { ok: false, detail: "the key service could not be reached" };
      }
      return {
        ok: false,
        detail: `a record under ${keyId} did not decrypt (${sample.type} ${sample.id})`,
      };
    }
  }
  return {
    ok: true,
    detail: `${total} encrypted record${total === 1 ? "" : "s"} under ${keyIds.length} key${keyIds.length === 1 ? "" : "s"}; one per key decrypted`,
  };
}

/** One encrypted record under `keyId`, read inside its own tenant as the app would. */
async function sampleUnder(client: VerifyOptions["client"], keyId: string) {
  // The list gives ids and key ids only, a page at a time in a stable order.
  // Excluding a key id nobody has ('') lists everything.
  type Listed = {
    tenant_id: string;
    record_type: string;
    record_id: string;
    key_id: string | null;
  };
  let after: [string | null, string | null, string | null] = [null, null, null];
  let row: Listed | undefined;
  for (;;) {
    const { rows } = await client.query<Listed>(
      `SELECT tenant_id, record_type, record_id, key_id
       FROM list_encrypted_records('', $1::uuid, $2::text, $3::uuid, 1000)`,
      after,
    );
    row = rows.find((candidate) => candidate.key_id === keyId);
    if (row || rows.length < 1000) break;
    const last = rows[rows.length - 1]!;
    after = [last.tenant_id, last.record_type, last.record_id];
  }
  if (!row) return null;
  const isIntegration = row.record_type === "integration";
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [row.tenant_id]);
    const { rows: found } = await client.query<{ envelope: unknown }>(
      isIntegration
        ? "SELECT credentials_enc AS envelope FROM integrations WHERE id = $1"
        : "SELECT secret_enc AS envelope FROM notification_channels WHERE id = $1",
      [row.record_id],
    );
    const context: EncryptionContext = {
      tenantId: row.tenant_id,
      recordId: row.record_id,
      purpose: isIntegration ? "integration-credentials" : "notification-channel",
    };
    return found[0]
      ? { envelope: found[0].envelope, context, type: row.record_type, id: row.record_id }
      : null;
  } finally {
    await client.query("COMMIT");
  }
}
