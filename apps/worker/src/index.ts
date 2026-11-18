import { isMockAllowed } from "@valtrexia/connectors";
import { brand } from "@valtrexia/core";
import {
  assertProductionTransport,
  createEmailSenderFromEnv,
  createKeyProviderFromEnv,
  createLogger,
  operatorAlertConfigFromEnv,
  outboundPolicyFromEnv,
} from "@valtrexia/core/server";
import { createDb } from "@valtrexia/db";
import { parseConfig } from "./config";
import { startWorker } from "./worker";

async function main(): Promise<void> {
  const config = parseConfig(process.env);
  assertProductionTransport(process.env);
  const operatorAlerts = operatorAlertConfigFromEnv(process.env);
  const logger = createLogger({ name: "worker", level: config.logLevel });

  // Each running sync holds at most one connection at a time; leave headroom
  // for the scheduler.
  const db = createDb({ url: config.databaseUrl, maxConnections: config.syncConcurrency + 2 });

  // Tenant isolation rests on row-level security, which a privileged role
  // would bypass. Refuse to do any work as one.
  await db.assertSafeRole();

  const worker = await startWorker({
    db,
    keyProvider: createKeyProviderFromEnv(process.env),
    logger,
    redisUrl: config.redisUrl,
    allowMock: isMockAllowed(process.env),
    syncIntervalMinutes: config.syncIntervalMinutes,
    syncConcurrency: config.syncConcurrency,
    schedulerTickSeconds: config.schedulerTickSeconds,
    notificationTickSeconds: config.notificationTickSeconds,
    outboundPolicy: outboundPolicyFromEnv(process.env),
    emailSender: createEmailSenderFromEnv(process.env, logger),
    dattoBaseUrl: config.dattoBaseUrl,
    retention: config.retention,
    operatorAlerts,
    operatorCheckSeconds: config.operatorCheckSeconds,
  });
  logger.info(`${brand.name} worker is running`);
  if (operatorAlerts.emails.length === 0 && !operatorAlerts.webhookUrl) {
    logger.warn(
      "no operator alert destination: problems with the service itself are only logged. Set OPERATOR_ALERT_EMAIL or OPERATOR_ALERT_WEBHOOK_URL.",
    );
  }

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "shutting down; waiting for running syncs to finish");
    worker
      .close()
      .then(() => db.disconnect())
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error({ err: error }, "shutdown failed");
        process.exit(1);
      });
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

main().catch((error: unknown) => {
  // Message only: an error object could carry connection details.
  console.error(error instanceof Error ? error.message : "The worker failed to start.");
  process.exit(1);
});
