import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import type { TestProject } from "vitest/node";

const run = promisify(execFile);
const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(packageDir, "..", "..");

export interface TestDatabaseUrls {
  /** Runtime role, subject to row-level security. What the tests exercise. */
  app: string;
  /** Owner role. Used only for catalog checks and to prove the role guard rejects it. */
  owner: string;
}

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrls: TestDatabaseUrls;
  }
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/**
 * Builds a fresh `<database>_test` next to the development database, applies
 * every migration to it as the owner role, and hands both connection strings
 * to the tests. The development database is never touched.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const envFile = join(repoRoot, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const ownerUrl = process.env.DATABASE_URL_OWNER;
  const appUrl = process.env.DATABASE_URL;
  if (!ownerUrl || !appUrl) {
    throw new Error(
      "Database tests need DATABASE_URL_OWNER and DATABASE_URL. Copy .env.example to .env and " +
        "start Postgres (pnpm infra:up). To run only the tests that need no services: pnpm test:unit",
    );
  }

  const baseName = new URL(ownerUrl).pathname.slice(1);
  const testName = `${baseName}_test`;
  if (!/^[a-z0-9_]+_test$/.test(testName)) {
    throw new Error(`Refusing to create a test database named "${testName}"`);
  }

  const admin = new pg.Client({ connectionString: ownerUrl });
  try {
    await admin.connect();
  } catch (cause) {
    throw new Error(
      "Could not connect to Postgres for the database tests. Is it running (pnpm infra:up)? " +
        "To run only the tests that need no services: pnpm test:unit",
      { cause },
    );
  }
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${testName} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${testName}`);
  } finally {
    await admin.end();
  }

  const urls: TestDatabaseUrls = {
    owner: withDatabase(ownerUrl, testName),
    app: withDatabase(appUrl, testName),
  };

  // Apply migrations exactly as a deployment would.
  const prismaCli = createRequire(join(packageDir, "package.json")).resolve(
    "prisma/build/index.js",
  );
  await run(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: packageDir,
    env: { ...process.env, DATABASE_URL_OWNER: urls.owner },
  });

  project.provide("databaseUrls", urls);

  return async () => {
    const cleanup = new pg.Client({ connectionString: ownerUrl });
    await cleanup.connect();
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS ${testName} WITH (FORCE)`);
    } finally {
      await cleanup.end();
    }
  };
}
