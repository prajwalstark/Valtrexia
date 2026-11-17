import type { VendorId } from "@valtrexia/core";
import {
  createGuardedFetch,
  type Logger,
  type OutboundPolicy,
  type Resolver,
  type Secret,
} from "@valtrexia/core/server";
import { DattoConnector } from "./datto/connector";
import { dattoCredentialsSchema } from "./datto/credentials";
import { ConnectorUnavailableError, InvalidCredentialsShapeError } from "./errors";
import { MockConnector, mockCredentialsSchema } from "./mock/connector";
import type { Connector } from "./types";
import { VspcConnector } from "./vspc/connector";
import { vspcCredentialsSchema } from "./vspc/credentials";

export interface ConnectorDeps {
  /**
   * Whether the mock vendor may be used. The caller decides from
   * configuration; it must be false in production.
   */
  allowMock: boolean;
  fetch?: typeof fetch;
  logger?: Logger;
  now?: () => Date;
  /**
   * Overrides Datto's API root. Server configuration only (DATTO_API_BASE_URL);
   * it must never come from user input, or it would let a user aim our
   * requests, and their own credentials, at an arbitrary host.
   */
  dattoBaseUrl?: string;
  /**
   * Retries after the first attempt. Lower it for interactive use, such as a
   * connection test, where a person is waiting.
   */
  maxRetries?: number;
  /**
   * What a tenant-supplied server address may be: a VSPC console is the
   * MSP's own server, named by whoever connects it. Strict unless set for
   * local development; never relaxed in production.
   */
  outboundPolicy?: OutboundPolicy;
  /** Replaces DNS for tenant-supplied addresses. For tests. */
  resolver?: Resolver;
}

/**
 * Builds the connector for an integration from its decrypted credentials.
 * This is the only place the rest of the system learns which class talks to
 * which vendor.
 */
export function createConnector(
  vendor: VendorId,
  credentials: Secret<unknown>,
  deps: ConnectorDeps,
): Connector {
  switch (vendor) {
    case "mock": {
      if (!deps.allowMock) {
        throw new ConnectorUnavailableError("Demo data is switched off in this environment.");
      }
      const parsed = mockCredentialsSchema.safeParse(credentials.expose());
      if (!parsed.success) throw new InvalidCredentialsShapeError();
      return new MockConnector(parsed.data, deps.now ? { now: deps.now } : {});
    }
    case "datto_bcdr": {
      const parsed = dattoCredentialsSchema.safeParse(credentials.expose());
      if (!parsed.success) throw new InvalidCredentialsShapeError();
      return new DattoConnector(parsed.data, {
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...(deps.logger ? { logger: deps.logger } : {}),
        ...(deps.dattoBaseUrl ? { baseUrl: deps.dattoBaseUrl } : {}),
        ...(deps.maxRetries !== undefined ? { maxRetries: deps.maxRetries } : {}),
      });
    }
    case "veeam_vspc": {
      const parsed = vspcCredentialsSchema.safeParse(credentials.expose());
      if (!parsed.success) throw new InvalidCredentialsShapeError();
      return new VspcConnector(parsed.data, {
        // The console's address came from a person. Every request goes
        // through the outbound guard: public addresses only, the connection
        // pinned to the addresses checked, GET only, no redirects followed.
        fetch:
          deps.fetch ??
          createGuardedFetch({
            policy: deps.outboundPolicy ?? {},
            ...(deps.resolver ? { resolver: deps.resolver } : {}),
          }),
        ...(deps.logger ? { logger: deps.logger } : {}),
        ...(deps.maxRetries !== undefined ? { maxRetries: deps.maxRetries } : {}),
      });
    }
    case "kaseya_uniview":
      throw new ConnectorUnavailableError("This vendor is planned but not available yet.");
    default: {
      const unreachable: never = vendor;
      throw new ConnectorUnavailableError(`Unknown vendor: ${String(unreachable)}`);
    }
  }
}

/** Whether demo data may be used, from the environment. Never in production. */
export function isMockAllowed(env: {
  NODE_ENV?: string | undefined;
  VALTREXIA_ENABLE_MOCK?: string | undefined;
}): boolean {
  return env.VALTREXIA_ENABLE_MOCK === "true" && env.NODE_ENV !== "production";
}
