import "server-only";
import { isMockAllowed } from "@valtrexia/connectors";
import { createLogger } from "@valtrexia/core/server";
import { getSafeDb } from "./db";
import type { IntegrationDeps } from "./integrations-core";
import { getKeyProvider } from "./keys";
import { createRateLimiter } from "./rate-limit";
import { clientIp } from "./request";

const logger = createLogger({ name: "web" });

// Ten connection tests per tenant per minute: plenty for a person correcting
// a typo, far too few to try keys against a vendor in bulk.
const connectionTestLimiter = createRateLimiter({ limit: 10, windowMs: 60_000 });

/** What the integrations logic needs, assembled from configuration for one request. */
export async function integrationDeps(): Promise<IntegrationDeps> {
  // Server configuration only. This must never be taken from a request.
  const dattoBaseUrl = process.env.DATTO_API_BASE_URL;
  return {
    db: await getSafeDb(),
    keyProvider: getKeyProvider(),
    connectorDeps: {
      allowMock: isMockAllowed(process.env),
      logger,
      // A person is waiting: one retry, not the sync job's patient four.
      maxRetries: 1,
      ...(dattoBaseUrl ? { dattoBaseUrl } : {}),
    },
    limiter: connectionTestLimiter,
    logger,
    ip: await clientIp(),
  };
}
