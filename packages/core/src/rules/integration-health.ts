import { STALE_SYNC_AFTER_INTERVALS } from "./missed-backup";

const MINUTE_MS = 60 * 1000;

/**
 * Why a sync failed, in the terms that decide what happens next. Stored on
 * the integration beside the message shown to people.
 */
export const SYNC_ERROR_KINDS = [
  /** The vendor rejected the credentials. */
  "auth",
  /** The saved credentials could not be decrypted or are incomplete. */
  "credentials",
  /** The vendor kept rate limiting us past our retry budget. */
  "rate_limited",
  /** No answer: DNS, connection, TLS or timeout. */
  "network",
  /** The vendor answered with an error status. */
  "vendor",
  /** The vendor answered with something its API is not documented to return. */
  "invalid_response",
  /** No connector is available for this vendor here. */
  "unavailable",
  /** Anything else, including a fault of our own. */
  "internal",
] as const;
export type SyncErrorKind = (typeof SYNC_ERROR_KINDS)[number];

/**
 * Failures that will not clear by themselves. Retrying a rejected key gets
 * the same answer every time; someone has to change something.
 */
export const ACTION_REQUIRED_ERROR_KINDS: readonly SyncErrorKind[] = ["auth", "credentials"];

/** Failed syncs in a row before an integration counts as unhealthy: an hour at the default interval. */
export const UNHEALTHY_AFTER_FAILURES = 4;

export type IntegrationHealthState =
  /** Connected, and its first sync has not finished yet. */
  | "waiting"
  /** The last sync succeeded and is recent. */
  | "healthy"
  /** Failing, but so far within what a passing vendor problem looks like. */
  | "retrying"
  /** Failing in a way, or for long enough, that someone should look. */
  | "unhealthy"
  /**
   * Nothing is failing, and nothing is arriving either: no sync has finished
   * for longer than several intervals. The worker is not running, or a sync
   * is stuck.
   */
  | "stalled";

export interface IntegrationHealthInput {
  now: Date;
  syncStatus: "never" | "running" | "ok" | "error";
  /** When data was last pulled from the vendor successfully. */
  lastSyncAt: Date | null;
  /** When the integration was connected. The reference until it has synced. */
  createdAt: Date;
  consecutiveFailures: number;
  /** When the current run of failures began. */
  failingSince: Date | null;
  lastSyncErrorKind: SyncErrorKind | null;
  /** How often integrations are synced, in minutes. */
  syncIntervalMinutes: number;
}

export interface IntegrationHealth {
  state: IntegrationHealthState;
  /** When the problem began, for the states that are problems. */
  since: Date | null;
  /** True when retrying cannot fix it: the credentials need replacing. */
  needsAction: boolean;
}

/**
 * Judges an integration from what its syncs have recorded and from the clock.
 *
 * The clock matters because the failure that hides best is the one that
 * records nothing. If the worker stops, no sync fails, no error is stored,
 * and every stored status goes on looking as it did. So an integration whose
 * last successful sync is older than a few intervals is "stalled" even though
 * no sync has reported a problem.
 */
export function assessIntegrationHealth(input: IntegrationHealthInput): IntegrationHealth {
  if (!(input.syncIntervalMinutes > 0) || !Number.isFinite(input.syncIntervalMinutes)) {
    throw new RangeError("syncIntervalMinutes must be a positive number");
  }

  // A run of failures stays a run of failures while the next attempt is in
  // progress: `syncStatus` is "running" then, but nothing has succeeded yet.
  const failing = input.syncStatus === "error" || input.consecutiveFailures > 0;
  if (failing) {
    const needsAction =
      input.lastSyncErrorKind !== null &&
      ACTION_REQUIRED_ERROR_KINDS.includes(input.lastSyncErrorKind);
    const unhealthy = needsAction || input.consecutiveFailures >= UNHEALTHY_AFTER_FAILURES;
    return {
      state: unhealthy ? "unhealthy" : "retrying",
      since: input.failingSince,
      needsAction,
    };
  }

  const staleAfterMs = STALE_SYNC_AFTER_INTERVALS * input.syncIntervalMinutes * MINUTE_MS;
  const reference = input.lastSyncAt ?? input.createdAt;
  if (input.now.getTime() - reference.getTime() > staleAfterMs) {
    return { state: "stalled", since: reference, needsAction: false };
  }

  return {
    state: input.lastSyncAt === null ? "waiting" : "healthy",
    since: null,
    needsAction: false,
  };
}
