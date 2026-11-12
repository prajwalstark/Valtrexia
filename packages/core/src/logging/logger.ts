import pino, { type DestinationStream, type Logger } from "pino";
import { redact, scrubString } from "./redact";

export type { Logger } from "pino";

export interface CreateLoggerOptions {
  /** Which process is logging, for example "worker" or "web". */
  name: string;
  /** Minimum level. Defaults to LOG_LEVEL, then "info". */
  level?: string;
  /** Where to write. Defaults to standard output. */
  destination?: DestinationStream;
}

/**
 * Structured JSON logger. Everything passed to it goes through `redact`
 * first, so credentials and vendor payloads are removed whatever the call
 * site does:
 *
 *   log.info({ integrationId, credentials }, "sync started")
 *   // {"integrationId":"...","credentials":"[redacted]","msg":"sync started"}
 *
 * Redaction is the safety net, not the plan. Do not pass secrets to the
 * logger in the first place.
 */
export function createLogger({ name, level, destination }: CreateLoggerOptions): Logger {
  const root = pino(
    {
      name,
      level: level ?? process.env.LOG_LEVEL ?? "info",
      // pino applies its own `err` serializer after the log formatter, which
      // would rebuild the error we have already flattened. Turn it off.
      serializers: { err: (value: unknown) => value },
      formatters: {
        level: (label) => ({ level: label }),
        log: (object) => redact(object) as Record<string, unknown>,
      },
      hooks: {
        logMethod(args, method) {
          const scrubbed = args.map((arg) => (typeof arg === "string" ? scrubString(arg) : arg));
          method.apply(this, scrubbed as Parameters<typeof method>);
        },
      },
    },
    destination,
  );
  return redactChildBindings(root);
}

/**
 * pino does not run formatters over the bindings given to `child()`; it
 * serializes them once, as they are. Wrap `child` so they are redacted too,
 * and so that children of children stay wrapped.
 */
function redactChildBindings(logger: Logger): Logger {
  const child = logger.child.bind(logger);
  const redacting = (bindings: Record<string, unknown>, options?: object): Logger =>
    redactChildBindings(child(redact(bindings) as Record<string, unknown>, options));
  logger.child = redacting as unknown as Logger["child"];
  return logger;
}
