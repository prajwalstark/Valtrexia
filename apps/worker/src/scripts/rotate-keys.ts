/**
 * Moves every encrypted record to the current key.
 *
 *   pnpm keys:rotate              re-wrap everything not under the current key
 *   pnpm keys:rotate --dry-run    count what would move, change nothing
 *   pnpm keys:rotate --batch-size=50
 *
 * Uses the same configuration as the app (DATABASE_URL and the key provider
 * settings) and the runtime database role. Configure the new key as current
 * and keep the old one readable before running it; see "Rotating the key"
 * in the README. Exits non-zero if anything is left to do.
 */
import {
  assertProductionTransport,
  createKeyProviderFromEnv,
  createLogger,
} from "@valtrexia/core/server";
import { createDb } from "@valtrexia/db";
import { rotateKeys } from "../keys/rotate";

async function main(): Promise<number> {
  // pnpm may pass a "--" separator through; it is not an option.
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const dryRun = args.includes("--dry-run");
  const sizeArg = args.find((arg) => arg.startsWith("--batch-size="));
  const batchSize = sizeArg ? Number(sizeArg.split("=")[1]) : undefined;
  const unknown = args.filter((arg) => arg !== "--dry-run" && !arg.startsWith("--batch-size="));
  if (unknown.length > 0 || (batchSize !== undefined && !(batchSize >= 1))) {
    console.error("Usage: pnpm keys:rotate [--dry-run] [--batch-size=N]");
    return 2;
  }

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  assertProductionTransport(process.env, { database: true });
  const logger = createLogger({ name: "rotate-keys", level: process.env.LOG_LEVEL ?? "info" });
  const keyProvider = createKeyProviderFromEnv(process.env);
  const db = createDb({ url, maxConnections: 2 });
  try {
    await db.assertSafeRole();
    const summary = await rotateKeys(
      { db, keyProvider, logger },
      { dryRun, ...(batchSize ? { batchSize } : {}) },
    );
    const lines = [
      `Current key: ${summary.currentKeyId}`,
      dryRun
        ? `Records under another key: ${summary.examined} (dry run, nothing changed)`
        : `Re-wrapped: ${summary.rewrapped}. Skipped (changed meanwhile): ${summary.skipped}.`,
    ];
    if (summary.unreadable.length > 0) {
      lines.push(`Unreadable with every configured key: ${summary.unreadable.length}`);
      for (const record of summary.unreadable) {
        lines.push(`  ${record.type} ${record.id} (tenant ${record.tenantId})`);
      }
    }
    if (summary.interrupted) {
      lines.push("Stopped early: the key service did not answer. Run the command again to resume.");
    }
    for (const { keyId, records } of summary.remaining) {
      lines.push(`Still under ${keyId ?? "no key"}: ${records}`);
    }
    if (summary.remaining.length === 0) lines.push("Every record is under the current key.");
    console.log(lines.join("\n"));
    return summary.remaining.length === 0 ? 0 : 1;
  } finally {
    await db.disconnect();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : "Key rotation failed.");
    process.exitCode = 1;
  },
);
