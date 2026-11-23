import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * What a correctly built database contains, beyond its tables: the facts
 * the tenant-isolation tests check on every test run, and `pnpm db:verify`
 * checks on a restored copy. One list, so the two cannot drift apart.
 */

/** The runtime role every request uses. Its name is fixed by the migrations' grants. */
export const APP_ROLE = "valtrexia_app";

/**
 * Every SECURITY DEFINER function, each narrow, each pinning search_path and
 * executable only by the runtime role. A new one must be added here on purpose.
 */
export const DEFINER_FUNCTIONS = [
  "applied_migrations",
  "apply_retention",
  "count_encrypted_records_by_key",
  "fleet_health_counts",
  "list_due_integrations",
  "list_due_notification_batches",
  "list_encrypted_records",
  "provision_tenant",
  "purge_due_tenants",
  "resolve_tenant_id",
] as const;

/** The search_path every definer function must set. */
export const DEFINER_SEARCH_PATH = "search_path=pg_catalog, pg_temp";

/** The migrations in this codebase, by name, oldest first. */
export function migrationNames(
  directory = join(dirname(fileURLToPath(import.meta.url)), "..", "prisma", "migrations"),
): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{14}_[a-z0-9_]+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}
