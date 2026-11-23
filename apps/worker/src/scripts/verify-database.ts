/**
 * Checks that a database is safe to serve from: typically one just restored
 * from a backup, before any traffic is sent to it.
 *
 *   pnpm db:verify                   check DATABASE_URL with the configured key
 *   pnpm db:verify --allow-empty     a new deployment with nothing encrypted yet
 *
 * Connects with DATABASE_URL, as the runtime role, exactly as the app will,
 * and uses the same key settings as the app. Exits 0 only if every check
 * passes. Prints names and counts; never a credential or a tenant's data.
 * In the worker image: node --import tsx src/scripts/verify-database.ts
 */
import { assertProductionTransport, createKeyProviderFromEnv } from "@valtrexia/core/server";
import { migrationNames, verifyDatabase } from "@valtrexia/db";
import pg from "pg";

async function main(): Promise<number> {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const unknown = args.filter((arg) => arg !== "--allow-empty");
  if (unknown.length > 0) {
    console.error("Usage: pnpm db:verify [--allow-empty]");
    return 2;
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  assertProductionTransport(process.env, { database: true });

  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    const checks = await verifyDatabase({
      client,
      expectedMigrations: migrationNames(),
      keyProvider: createKeyProviderFromEnv(process.env),
      allowNoRecords: args.includes("--allow-empty"),
    });
    for (const check of checks) {
      console.log(`${check.ok ? "ok  " : "FAIL"}  ${check.name.padEnd(10)}  ${check.detail}`);
    }
    const failed = checks.filter((check) => !check.ok).length;
    console.log(
      failed === 0
        ? "\nThis database is safe to serve from."
        : `\n${failed} of ${checks.length} checks failed. Do not send traffic to this database.`,
    );
    return failed === 0 ? 0 : 1;
  } finally {
    await client.end();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // The message only: a connection error can carry the URL's details.
    console.error(error instanceof Error ? error.message.split("\n")[0] : "Verification failed.");
    process.exitCode = 1;
  },
);
