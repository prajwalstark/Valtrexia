import { createHash, timingSafeEqual } from "node:crypto";
import type { Redis } from "ioredis";
import {
  heartbeatAt,
  heartbeatKeyPattern,
  isHeartbeatFresh,
  type FleetSnapshot,
} from "@valtrexia/core/server";

/**
 * The service's own health, for an external monitor (CloudWatch Synthetics,
 * an uptime service) to poll. It is what notices a stopped worker, which
 * cannot report its own death. Counts and condition names only: no tenant,
 * name, host or error text.
 */

/** The shortest token accepted, so the endpoint cannot be left guessable. */
export const MIN_STATUS_TOKEN_LENGTH = 32;

export interface StatusDeps {
  /** OPERATOR_STATUS_TOKEN. Unset or too short: the endpoint answers 404. */
  token: string | undefined;
  /** Heartbeat values of every worker, as stored. */
  heartbeats(): Promise<(string | null)[]>;
  /** The latest fleet check, as stored. */
  fleetSnapshot(): Promise<string | null>;
  openAlerts(): Promise<{ condition: string; openedAt: Date }[]>;
  now: number;
  /** OPERATOR_CHECK_SECONDS: the snapshot counts as stale after three of these. */
  checkSeconds: number;
}

export interface StatusBody {
  status: "ok" | "problem";
  problems: string[];
  workers: { alive: number; newestHeartbeatSecondsAgo: number | null };
  fleetCheckedSecondsAgo: number | null;
  fleet: Omit<FleetSnapshot, "at"> | null;
  openAlerts: { condition: string; since: string }[];
}

export type StatusResponse =
  /** No token configured: the endpoint does not exist. */
  | { kind: "off" }
  | { kind: "unauthorized" }
  | { kind: "report"; status: 200 | 503; body: StatusBody };

export async function operatorStatus(
  authorization: string | null,
  deps: StatusDeps,
): Promise<StatusResponse> {
  const token = deps.token?.trim();
  if (!token || token.length < MIN_STATUS_TOKEN_LENGTH) return { kind: "off" };
  if (!sameSecret(authorization ?? "", `Bearer ${token}`)) return { kind: "unauthorized" };

  const [beats, stored, alerts] = await Promise.all([
    deps.heartbeats(),
    deps.fleetSnapshot(),
    deps.openAlerts(),
  ]);

  const alive = beats.filter((beat) => isHeartbeatFresh(beat, deps.now)).length;
  const times = beats.map(heartbeatAt).filter((at): at is number => at !== null);
  const newest = times.length > 0 ? Math.max(...times) : null;

  let snapshot: FleetSnapshot | null = null;
  try {
    snapshot = stored ? (JSON.parse(stored) as FleetSnapshot) : null;
  } catch {
    snapshot = null;
  }
  const checkedAt = snapshot ? Date.parse(snapshot.at) : Number.NaN;
  const checkedAgo = Number.isFinite(checkedAt) ? Math.max(0, deps.now - checkedAt) : null;

  const problems: string[] = [];
  if (alive === 0) problems.push("no_worker_heartbeat");
  if (checkedAgo === null || checkedAgo > 3 * deps.checkSeconds * 1000) {
    problems.push("fleet_check_stale");
  }
  for (const alert of alerts) problems.push(alert.condition);

  const fleet = snapshot
    ? {
        integrations: snapshot.integrations,
        notifications: snapshot.notifications,
        maintenance: snapshot.maintenance,
        queues: snapshot.queues,
      }
    : null;
  const body: StatusBody = {
    status: problems.length === 0 ? "ok" : "problem",
    problems,
    workers: {
      alive,
      newestHeartbeatSecondsAgo:
        newest === null ? null : Math.max(0, Math.round((deps.now - newest) / 1000)),
    },
    fleetCheckedSecondsAgo: checkedAgo === null ? null : Math.round(checkedAgo / 1000),
    fleet,
    openAlerts: alerts.map((alert) => ({
      condition: alert.condition,
      since: alert.openedAt.toISOString(),
    })),
  };
  return { kind: "report", status: problems.length === 0 ? 200 : 503, body };
}

/** Compares in constant time, whatever the lengths. */
function sameSecret(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Every heartbeat key, read with SCAN (never KEYS, which blocks Redis). */
export async function readHeartbeats(
  redis: Pick<Redis, "scan" | "mget">,
): Promise<(string | null)[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, "MATCH", heartbeatKeyPattern(), "COUNT", 100);
    keys.push(...batch);
    cursor = next;
  } while (cursor !== "0" && keys.length < 1_000);
  return keys.length > 0 ? redis.mget(...keys) : [];
}
