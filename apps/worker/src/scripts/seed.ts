/**
 * Loads demo data: a tenant, a demo-vendor integration, and a real sync of
 * it. Uses exactly the code path production uses (runtime database role,
 * `withTenant`, encrypted credentials, the sync pipeline), so a seeded
 * database looks like one a real integration filled.
 *
 * Safe to run again: it reuses the tenant and integration and syncs anew.
 *
 *   pnpm db:seed
 *
 * Environment:
 *   SEED_CLERK_ORG_ID   Clerk organization to attach the demo tenant to.
 *                       Set this to your own org id to see the data after
 *                       signing in. Default: org_demo_seed
 *   SEED_TENANT_NAME    Default: Demo MSP
 */
import { isMockAllowed } from "@valtrexia/connectors";
import { getVendor, summarizeClientHealth } from "@valtrexia/core";
import { createKeyProviderFromEnv, createLogger, Secret } from "@valtrexia/core/server";
import { createDb, createIntegration } from "@valtrexia/db";
import { syncIntegration } from "../sync/sync-integration";

const DEMO_INTEGRATION_NAME = getVendor("mock").name;

async function main(): Promise<void> {
  if (!isMockAllowed(process.env)) {
    throw new Error(
      "Seeding uses the demo vendor, which is switched off. Set VALTREXIA_ENABLE_MOCK=true " +
        "(it is never allowed when NODE_ENV=production).",
    );
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set. Copy .env.example to .env.");

  const logger = createLogger({ name: "seed", level: process.env.LOG_LEVEL ?? "warn" });
  const keyProvider = createKeyProviderFromEnv(process.env);
  const db = createDb({ url, maxConnections: 2 });

  try {
    await db.assertSafeRole();

    const clerkOrgId = process.env.SEED_CLERK_ORG_ID ?? "org_demo_seed";
    const tenantId = await db.provisionTenant({
      clerkOrgId,
      name: process.env.SEED_TENANT_NAME ?? "Demo MSP",
    });

    const integration = await db.withTenant(tenantId, async (context) => {
      const existing = await context.tx.integration.findFirst({
        where: { vendor: "mock", name: DEMO_INTEGRATION_NAME },
        select: { id: true },
      });
      return (
        existing ??
        createIntegration(context, keyProvider, {
          vendor: "mock",
          name: DEMO_INTEGRATION_NAME,
          credentials: new Secret({ seed: "demo" }),
          actorUserId: null,
        })
      );
    });

    const summary = await syncIntegration(
      { db, keyProvider, logger, allowMock: true },
      { tenantId, integrationId: integration.id },
    );

    const health = await db.withTenant(tenantId, async ({ tx }) => {
      const clients = await tx.client.findMany({ include: { assets: true } });
      const levels = { red: 0, amber: 0, green: 0, none: 0 };
      for (const client of clients) {
        levels[summarizeClientHealth(client.assets, { now: new Date() }).health] += 1;
      }
      return levels;
    });

    const s = summary.statusCounts;
    console.log(
      [
        `Seeded tenant ${tenantId} (Clerk organization: ${clerkOrgId})`,
        `  clients   ${summary.clients}  (red ${health.red}, amber ${health.amber}, green ${health.green})`,
        `  assets    ${summary.assets}  (success ${s.success}, warning ${s.warning}, failed ${s.failed}, ` +
          `missed ${s.missed}, running ${s.running}, unknown ${s.unknown})`,
        `  results   ${summary.resultsCreated} new, ${summary.resultsUpdated} updated, ` +
          `since ${summary.since.toISOString()}`,
      ].join("\n"),
    );
  } finally {
    await db.disconnect();
  }
}

main().catch((error: unknown) => {
  // Message only: an error object could carry connection details.
  console.error(error instanceof Error ? error.message : "Seeding failed.");
  process.exitCode = 1;
});
