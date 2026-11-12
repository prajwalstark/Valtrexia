/**
 * Errors connectors throw. Messages are written to be shown to an MSP
 * technician and stored on the integration, so they never contain
 * credentials, request headers or response bodies.
 */
export abstract class ConnectorError extends Error {
  /** Whether trying again later could succeed without anyone changing anything. */
  abstract readonly retryable: boolean;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The vendor rejected the credentials (HTTP 401 or 403). */
export class AuthError extends ConnectorError {
  readonly retryable = false;
  constructor(readonly status: number) {
    super("The vendor rejected these credentials. Check the keys and their permissions.");
  }
}

/** The vendor is rate limiting us and did not let up within our retry budget. */
export class RateLimitError extends ConnectorError {
  readonly retryable = true;
  /** @param retryAfterMs How long the vendor asked us to wait, when it said. */
  constructor(readonly retryAfterMs: number | null) {
    super("The vendor is rate limiting requests. The sync will be retried later.");
  }
}

/** The vendor answered with an error status that is not about credentials or rate limits. */
export class VendorError extends ConnectorError {
  readonly retryable: boolean;
  constructor(readonly status: number) {
    super(`The vendor API returned an error (HTTP ${status}).`);
    this.retryable = status >= 500 || status === 408;
  }
}

/** The request never got an answer: DNS, connection, TLS or timeout. */
export class NetworkError extends ConnectorError {
  readonly retryable = true;
  constructor(
    readonly timedOut: boolean,
    options?: { cause?: unknown },
  ) {
    super(
      timedOut ? "The vendor API did not respond in time." : "The vendor API could not be reached.",
      options,
    );
  }
}

/** The vendor answered, but not with what its API is documented to return. */
export class InvalidResponseError extends ConnectorError {
  readonly retryable = false;
  constructor(what: string) {
    super(`The vendor API returned an unexpected response (${what}).`);
  }
}

/** The connector for this vendor does not exist yet, or is switched off. */
export class ConnectorUnavailableError extends ConnectorError {
  readonly retryable = false;
}

/** The stored credentials do not have the shape this vendor needs. */
export class InvalidCredentialsShapeError extends ConnectorError {
  readonly retryable = false;
  constructor() {
    super("The saved credentials are incomplete. Enter them again.");
  }
}
