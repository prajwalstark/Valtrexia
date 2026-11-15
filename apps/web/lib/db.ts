import "server-only";
import { getDb, type Db } from "@valtrexia/db";

let checked: Promise<Db> | undefined;

/**
 * The database handle for the web app. The first call verifies that the
 * connection is not a superuser, cannot bypass row-level security and owns no
 * tables, and refuses to hand out the handle otherwise. Tenant isolation
 * depends on that, so nothing in the web app may reach the database any
 * other way.
 */
export function getSafeDb(): Promise<Db> {
  checked ??= (async () => {
    const db = getDb();
    await db.assertSafeRole();
    return db;
  })().catch((error: unknown) => {
    // Do not cache a failure: the cause may be transient (database starting).
    checked = undefined;
    throw error;
  });
  return checked;
}
