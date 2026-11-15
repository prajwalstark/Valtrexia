import {
  assessIntegrationHealth,
  type BackupStatus,
  type ClientHealth,
  type IntegrationHealthState,
  type SyncErrorKind,
} from "@valtrexia/core";
import type { IntegrationProblem } from "./dashboard-core";
import { count, elapsed, formatDateTime, timeAgo } from "./format";

/** Statuses in the order they are always listed and drawn: worst first. */
export const STATUS_ORDER: readonly BackupStatus[] = [
  "failed",
  "missed",
  "warning",
  "unknown",
  "running",
  "success",
];

const NOUN: Record<BackupStatus, string> = {
  failed: "failed",
  missed: "missed",
  warning: "with warnings",
  unknown: "unknown",
  running: "running",
  success: "backed up",
};

/**
 * One line on the state of a client's backups, for the dashboard list.
 * It names what is wrong and how much of the client that is.
 */
export function describeClient(summary: ClientHealth): string {
  const { counts, watched, excluded, health } = summary;

  if (health === "none") {
    return excluded > 0
      ? `${count(excluded, "asset")}, none being watched`
      : "No protected assets found yet";
  }

  if (health === "green") {
    return counts.running > 0
      ? `${counts.success} backed up, ${counts.running} running`
      : watched === 1
        ? "Its 1 asset is backed up"
        : `All ${watched} assets backed up`;
  }

  const wrong = (
    health === "red" ? ["failed", "missed"] : ["warning", "unknown"]
  ) as BackupStatus[];
  const parts = wrong.filter((status) => counts[status] > 0).map((s) => `${counts[s]} ${NOUN[s]}`);
  // Amber with nothing wrong on any asset: the vendor's data is not arriving,
  // because its sync is failing or has stopped.
  if (parts.length === 0) {
    return `Vendor data out of date; ${count(watched, "asset")} not confirmed`;
  }
  return `${parts.join(", ")} of ${count(watched, "asset")}`;
}

/** What a sync's state looks like: which colour its icon takes, and one sentence. */
export interface SyncDescription {
  state: IntegrationHealthState;
  /** True while a sync is in progress and nothing is wrong. */
  syncing: boolean;
  text: string;
}

export interface SyncFacts {
  syncStatus: "never" | "running" | "ok" | "error";
  lastSyncAt: Date | null;
  lastSyncError: string | null;
  lastSyncErrorKind: SyncErrorKind | null;
  consecutiveFailures: number;
  failingSince: Date | null;
  createdAt: Date;
}

/**
 * One sentence on how an integration's syncs are going, for the integrations
 * pages. It says how long a problem has lasted and whether waiting will help.
 */
export function describeSync(
  facts: SyncFacts,
  now: Date,
  syncIntervalMinutes: number,
): SyncDescription {
  const health = assessIntegrationHealth({ now, syncIntervalMinutes, ...facts });
  const last = facts.lastSyncAt ? `Last synced ${timeAgo(facts.lastSyncAt, now)}.` : null;
  const reason = facts.lastSyncError ?? "The last sync did not complete.";
  const join = (...parts: (string | null)[]) => parts.filter(Boolean).join(" ");

  switch (health.state) {
    case "waiting":
      return { state: "waiting", syncing: false, text: "Waiting for its first sync" };
    case "healthy": {
      const syncing = facts.syncStatus === "running";
      return {
        state: "healthy",
        syncing,
        text: syncing ? join("Syncing now.", last) : (last ?? "Synced").replace(/\.$/, ""),
      };
    }
    case "retrying":
      return {
        state: "retrying",
        syncing: false,
        text: join("The last sync failed and will be retried.", reason, last),
      };
    case "unhealthy": {
      const since = health.since ? ` since ${formatDateTime(health.since)}` : "";
      const attempts =
        facts.consecutiveFailures > 1 ? ` (${facts.consecutiveFailures} attempts)` : "";
      return {
        state: "unhealthy",
        syncing: false,
        text: join(
          `Sync failing${since}${attempts}.`,
          reason,
          health.needsAction ? "It will keep failing until the keys are replaced." : null,
          last,
        ),
      };
    }
    case "stalled":
      return {
        state: "stalled",
        syncing: false,
        text: facts.lastSyncAt
          ? `No sync has finished since ${formatDateTime(facts.lastSyncAt)}. Syncs should run every ${count(syncIntervalMinutes, "minute")}; the background worker may not be running.`
          : `Connected ${timeAgo(facts.createdAt, now)} and not synced yet. The background worker may not be running.`,
      };
  }
}

/**
 * One sentence for the dashboard about an integration whose data cannot be
 * relied on, and the words for the link to it.
 */
export function describeIntegrationProblem(
  problem: IntegrationProblem,
  now: Date,
): { text: string; action: string } {
  const unconfirmed =
    problem.unconfirmedAssets > 0
      ? ` ${count(problem.unconfirmedAssets, "asset")} can no longer be confirmed.`
      : "";

  if (problem.state === "stalled") {
    return {
      text:
        (problem.lastSyncAt
          ? `${problem.name} has not synced since ${formatDateTime(problem.lastSyncAt)}.`
          : `${problem.name} has not synced yet.`) + unconfirmed,
      action: "View integration",
    };
  }
  if (problem.state === "retrying") {
    return {
      text: `${problem.name}: the last sync failed and will be retried.${unconfirmed}`,
      action: "View integration",
    };
  }
  const duration = problem.since ? ` for ${elapsed(problem.since, now)}` : "";
  return {
    text: `${problem.name} has been failing to sync${duration}. ${problem.error ?? "The last sync did not complete."}${unconfirmed}`,
    action: problem.needsAction ? "Replace the keys" : "View integration",
  };
}
