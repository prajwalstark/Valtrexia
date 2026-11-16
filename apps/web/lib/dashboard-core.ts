import {
  assessIntegrationHealth,
  compareWorstFirst,
  effectiveSlaHours,
  evaluateMissedBackup,
  HEALTH_LEVELS,
  isWatched,
  statusInView,
  statusSeverity,
  summarizeClientHealth,
  SYNC_INTERVAL_MINUTES,
  worstStatus,
  type BackupStatus,
  type ClientHealth,
  type Health,
  type IntegrationHealth,
  type SyncErrorKind,
  type VendorId,
} from "@valtrexia/core";
import { recordAudit, type Db } from "@valtrexia/db";
import { z } from "zod";
import type { ActionState } from "./integrations-core";
import type { TenantSession } from "./session-core";

/**
 * What the dashboard and the client page show, read for one tenant. No
 * framework code, so it is tested directly against Postgres.
 *
 * Nothing returned from here contains credentials or a vendor's raw payload.
 */

const DAY_MS = 86_400_000;
/** How far back the client page looks. */
export const HISTORY_DAYS = 14;
/** Results listed per asset. The day strip still covers every result. */
export const RESULTS_PER_ASSET = 50;

const emptyCounts = (): Record<BackupStatus, number> => ({
  success: 0,
  warning: 0,
  failed: 0,
  missed: 0,
  running: 0,
  unknown: 0,
});

export interface ReadDeps {
  db: Db;
  /** How often integrations are synced. Must match the worker's setting. */
  syncIntervalMinutes?: number;
}

/** The asset fields the missed-backup rule reads. */
const assetTimingSelect = {
  currentStatus: true,
  expectedFrequencyHours: true,
  slaHours: true,
  staleSince: true,
  firstSeenAt: true,
  lastSuccessAt: true,
  mutedUntil: true,
  isPaused: true,
  isArchived: true,
} as const;

interface AssetTiming {
  currentStatus: BackupStatus;
  expectedFrequencyHours: number;
  firstSeenAt: Date;
  lastSuccessAt: Date | null;
  mutedUntil: Date | null;
  isPaused: boolean;
  isArchived: boolean;
}

/** The integration fields that say how fresh its data is and how its syncs are going. */
const integrationHealthSelect = {
  id: true,
  name: true,
  vendor: true,
  syncStatus: true,
  lastSyncAt: true,
  lastSyncError: true,
  lastSyncErrorKind: true,
  consecutiveFailures: true,
  failingSince: true,
  createdAt: true,
} as const;

interface IntegrationFreshness {
  syncStatus: "never" | "running" | "ok" | "error";
  lastSyncAt: Date | null;
  lastSyncErrorKind: SyncErrorKind | null;
  consecutiveFailures: number;
  failingSince: Date | null;
  createdAt: Date;
}

interface Clock {
  now: Date;
  graceHours: number;
  syncIntervalMinutes: number;
}

/**
 * An asset's status as it should be shown now.
 *
 * The stored status dates from the integration's last successful sync. If
 * that sync is too old to say whether the asset's latest expected backup
 * happened, the asset is shown as `unknown` rather than as it last looked.
 * This is worked out here, on every read, so it holds even when the worker
 * has stopped and nothing is updating the stored value.
 */
function assetInView(
  asset: AssetTiming,
  integration: IntegrationFreshness,
  clock: Clock,
): { status: BackupStatus; unconfirmedSince: Date | null } {
  const verdict = evaluateMissedBackup({
    now: clock.now,
    asset: {
      expectedFrequencyHours: asset.expectedFrequencyHours,
      firstSeenAt: asset.firstSeenAt,
      lastCompletedAt: asset.lastSuccessAt,
      mutedUntil: asset.mutedUntil,
      isPaused: asset.isPaused,
      isArchived: asset.isArchived,
    },
    graceHours: clock.graceHours,
    integration: {
      // A retry in progress has not succeeded yet: the run of failures stands.
      syncStatus: integration.consecutiveFailures > 0 ? "error" : integration.syncStatus,
      lastSyncAt: integration.lastSyncAt,
    },
    syncIntervalMinutes: clock.syncIntervalMinutes,
  });
  return {
    status: statusInView(asset.currentStatus, verdict),
    unconfirmedSince: verdict.state === "unconfirmed" ? verdict.lastSyncAt : null,
  };
}

function integrationHealth(integration: IntegrationFreshness, clock: Clock): IntegrationHealth {
  return assessIntegrationHealth({
    now: clock.now,
    syncStatus: integration.syncStatus,
    lastSyncAt: integration.lastSyncAt,
    createdAt: integration.createdAt,
    consecutiveFailures: integration.consecutiveFailures,
    failingSince: integration.failingSince,
    lastSyncErrorKind: integration.lastSyncErrorKind,
    syncIntervalMinutes: clock.syncIntervalMinutes,
  });
}

/** An integration whose data cannot currently be relied on. */
export interface IntegrationProblem {
  id: string;
  name: string;
  vendor: VendorId;
  state: "retrying" | "unhealthy" | "stalled";
  /** When the failures began, or when data last arrived for a stalled integration. */
  since: Date | null;
  /** True when retrying cannot fix it: the credentials need replacing. */
  needsAction: boolean;
  /** The message recorded by the last failed sync. Written by us, never the vendor. */
  error: string | null;
  lastSyncAt: Date | null;
  /**
   * Watched assets shown as unknown because their backup window has closed
   * since this integration was last read. Assets last seen failed, missed or
   * with a warning are not counted: they are already listed as problems.
   */
  unconfirmedAssets: number;
}

export interface FleetClient {
  id: string;
  name: string;
  summary: ClientHealth;
  openIncidents: number;
}

export interface FleetOverview {
  /** Worst first. */
  clients: FleetClient[];
  /** How many clients are at each health level. */
  health: Record<Health, number>;
  assets: {
    watched: number;
    excluded: number;
    counts: Record<BackupStatus, number>;
    /** Watched assets that have gone longer than their SLA without a completed backup. */
    pastSla: number;
  };
  openIncidents: number;
  integrations: {
    total: number;
    /** Syncs are failing: retrying or unhealthy. */
    failing: number;
    /** Nothing is failing, but no sync has finished for several intervals. */
    stalled: number;
    /** Connected but not yet synced for the first time. */
    waiting: number;
    /** The most recent successful sync across all integrations. */
    lastSyncAt: Date | null;
    /** Every integration that is failing or stalled, worst first. */
    problems: IntegrationProblem[];
  };
}

/** Every client in the tenant with its health, worst first, plus fleet totals. */
export async function getFleetOverview(
  deps: ReadDeps,
  session: TenantSession,
  now: Date,
): Promise<FleetOverview> {
  const { tenant, integrations, clients, incidents } = await deps.db.withTenant(
    session.tenantId,
    async ({ tx }) => ({
      tenant: await tx.tenant.findUniqueOrThrow({
        where: { id: session.tenantId },
        select: { graceHours: true },
      }),
      integrations: await tx.integration.findMany({ select: integrationHealthSelect }),
      clients: await tx.client.findMany({
        select: {
          id: true,
          name: true,
          assets: { select: { ...assetTimingSelect, integrationId: true } },
        },
      }),
      incidents: await tx.incident.findMany({
        where: { closedAt: null },
        select: { asset: { select: { clientId: true } } },
      }),
    }),
  );
  const clock: Clock = {
    now,
    graceHours: tenant.graceHours,
    syncIntervalMinutes: deps.syncIntervalMinutes ?? SYNC_INTERVAL_MINUTES,
  };

  const integrationById = new Map(integrations.map((i) => [i.id, i]));
  const healthById = new Map(integrations.map((i) => [i.id, integrationHealth(i, clock)]));
  const unreliable = new Set(
    integrations
      .filter((i) => ["retrying", "unhealthy", "stalled"].includes(healthById.get(i.id)!.state))
      .map((i) => i.id),
  );
  const unconfirmedByIntegration = new Map<string, number>();

  const incidentsByClient = new Map<string, number>();
  for (const incident of incidents) {
    const clientId = incident.asset.clientId;
    incidentsByClient.set(clientId, (incidentsByClient.get(clientId) ?? 0) + 1);
  }

  const health = Object.fromEntries(HEALTH_LEVELS.map((level) => [level, 0])) as Record<
    Health,
    number
  >;
  const assets = { watched: 0, excluded: 0, counts: emptyCounts(), pastSla: 0 };

  const rows = clients.map((client): FleetClient => {
    const inView = client.assets.map((asset) => {
      const view = assetInView(asset, integrationById.get(asset.integrationId)!, clock);
      if (view.unconfirmedSince && view.status === "unknown" && isWatched(asset, now)) {
        unconfirmedByIntegration.set(
          asset.integrationId,
          (unconfirmedByIntegration.get(asset.integrationId) ?? 0) + 1,
        );
      }
      if (asset.staleSince && isWatched(asset, now)) assets.pastSla += 1;
      return { ...asset, currentStatus: view.status };
    });
    const summary = summarizeClientHealth(inView, {
      now,
      syncFailing: client.assets.some((a) => unreliable.has(a.integrationId)),
    });
    health[summary.health] += 1;
    assets.watched += summary.watched;
    assets.excluded += summary.excluded;
    for (const status of Object.keys(summary.counts) as BackupStatus[]) {
      assets.counts[status] += summary.counts[status];
    }
    return {
      id: client.id,
      name: client.name,
      summary,
      openIncidents: incidentsByClient.get(client.id) ?? 0,
    };
  });
  rows.sort(compareWorstFirst);

  const PROBLEM_ORDER = { unhealthy: 0, stalled: 1, retrying: 2 } as const;
  const problems = integrations
    .flatMap((integration): IntegrationProblem[] => {
      const { state, since, needsAction } = healthById.get(integration.id)!;
      if (state === "healthy" || state === "waiting") return [];
      return [
        {
          id: integration.id,
          name: integration.name,
          vendor: integration.vendor,
          state,
          since,
          needsAction,
          error: state === "stalled" ? null : integration.lastSyncError,
          lastSyncAt: integration.lastSyncAt,
          unconfirmedAssets: unconfirmedByIntegration.get(integration.id) ?? 0,
        },
      ];
    })
    .sort(
      (a, b) =>
        PROBLEM_ORDER[a.state] - PROBLEM_ORDER[b.state] ||
        b.unconfirmedAssets - a.unconfirmedAssets ||
        a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" }),
    );

  const states = [...healthById.values()].map((h) => h.state);
  const synced = integrations.flatMap((i) => (i.lastSyncAt ? [i.lastSyncAt.getTime()] : []));
  return {
    clients: rows,
    health,
    assets,
    openIncidents: incidents.length,
    integrations: {
      total: integrations.length,
      failing: states.filter((state) => state === "retrying" || state === "unhealthy").length,
      stalled: states.filter((state) => state === "stalled").length,
      waiting: states.filter((state) => state === "waiting").length,
      lastSyncAt: synced.length > 0 ? new Date(Math.max(...synced)) : null,
      problems,
    },
  };
}

export interface AssetDay {
  /** The UTC calendar day, as YYYY-MM-DD. */
  date: string;
  /** The worst result of the day, or null if there were none. */
  worst: BackupStatus | null;
  /** How many results the day had. */
  count: number;
}

/**
 * One cell per UTC day for the last `days` days, oldest first, ending today.
 * A day's cell shows its worst result, so a single failure is never hidden
 * behind later successes. A day with no results stays empty, which is how a
 * missed backup looks.
 */
export function buildDayStrip(
  results: Iterable<{ startedAt: Date; status: BackupStatus }>,
  now: Date,
  days: number = HISTORY_DAYS,
): AssetDay[] {
  const today = Math.floor(now.getTime() / DAY_MS);
  const buckets = new Map<number, BackupStatus[]>();
  for (const result of results) {
    const day = Math.floor(result.startedAt.getTime() / DAY_MS);
    if (day > today || day <= today - days) continue;
    buckets.set(day, [...(buckets.get(day) ?? []), result.status]);
  }
  return Array.from({ length: days }, (_, index) => {
    const day = today - (days - 1) + index;
    const statuses = buckets.get(day) ?? [];
    return {
      date: new Date(day * DAY_MS).toISOString().slice(0, 10),
      worst: worstStatus(statuses),
      count: statuses.length,
    };
  });
}

export interface AssetResult {
  id: string;
  startedAt: Date;
  endedAt: Date | null;
  status: BackupStatus;
  /** The vendor's own status value, verbatim. */
  vendorStatusRaw: string;
  message: string | null;
  screenshotVerified: boolean | null;
}

export interface OpenIncident {
  id: string;
  type: "failed" | "missed" | "stale";
  assetId: string;
  assetName: string;
  openedAt: Date;
  acknowledgedAt: Date | null;
  /** Who acknowledged it: their name, or their email if they have no name. */
  acknowledgedBy: string | null;
}

export interface ClientAsset {
  id: string;
  name: string;
  type: string;
  deviceName: string | null;
  integrationName: string;
  vendor: VendorId;
  /** The status to show now. `unknown` when `unconfirmedSince` is set. */
  currentStatus: BackupStatus;
  /**
   * Set when the asset's backup window has closed and its vendor has not been
   * read successfully since this time, so nothing newer is known.
   */
  unconfirmedSince: Date | null;
  /** What the vendor last reported, when the current status is the derived "missed". */
  lastResultStatus: BackupStatus | null;
  lastSuccessAt: Date | null;
  lastResultAt: Date | null;
  expectedFrequencyHours: number;
  /** The SLA applied to it, in hours: never shorter than its own backup window. */
  slaHours: number;
  /** When it went past that SLA without a completed backup. Null while inside it. */
  staleSince: Date | null;
  /** False when archived, paused or muted: shown, but not counted towards health. */
  watched: boolean;
  isPaused: boolean;
  isArchived: boolean;
  mutedUntil: Date | null;
  days: AssetDay[];
  /** The most recent results, newest first, at most RESULTS_PER_ASSET. */
  results: AssetResult[];
  /** How many results the asset has in the period, including any not listed. */
  resultCount: number;
}

export interface ClientDetail {
  id: string;
  name: string;
  summary: ClientHealth;
  /** Watched assets worst first, then the ones that are not watched. */
  assets: ClientAsset[];
  openIncidents: OpenIncident[];
}

/**
 * One client with its assets and the last 14 days of results. Returns null
 * for an id that is malformed, does not exist, or belongs to another tenant;
 * the caller cannot tell which, and should not be able to.
 */
export async function getClientDetail(
  deps: ReadDeps,
  session: TenantSession,
  clientId: string,
  now: Date,
): Promise<ClientDetail | null> {
  if (!z.uuid().safeParse(clientId).success) return null;
  const since = new Date((Math.floor(now.getTime() / DAY_MS) - (HISTORY_DAYS - 1)) * DAY_MS);

  const loaded = await deps.db.withTenant(session.tenantId, async ({ tx }) => {
    const client = await tx.client.findUnique({
      where: { id: clientId },
      select: {
        id: true,
        name: true,
        assets: {
          select: {
            id: true,
            name: true,
            type: true,
            deviceName: true,
            ...assetTimingSelect,
            lastResultStatus: true,
            lastResultAt: true,
            integrationId: true,
            integration: { select: integrationHealthSelect },
          },
        },
      },
    });
    if (!client) return null;

    // Named columns only: the raw vendor payload never leaves the database here.
    const results = await tx.backupResult.findMany({
      where: { asset: { clientId }, startedAt: { gte: since } },
      orderBy: { startedAt: "desc" },
      select: {
        id: true,
        assetId: true,
        startedAt: true,
        endedAt: true,
        status: true,
        vendorStatusRaw: true,
        message: true,
        screenshotVerified: true,
      },
    });
    const incidents = await tx.incident.findMany({
      where: { closedAt: null, asset: { clientId } },
      orderBy: { openedAt: "asc" },
      select: {
        id: true,
        type: true,
        assetId: true,
        openedAt: true,
        acknowledgedAt: true,
        asset: { select: { name: true } },
        acknowledgedBy: { select: { name: true, email: true } },
      },
    });
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: session.tenantId },
      select: { graceHours: true },
    });
    return { client, results, incidents, graceHours: tenant.graceHours };
  });
  if (!loaded) return null;
  const { client, results, incidents } = loaded;
  const clock: Clock = {
    now,
    graceHours: loaded.graceHours,
    syncIntervalMinutes: deps.syncIntervalMinutes ?? SYNC_INTERVAL_MINUTES,
  };
  const views = new Map(
    client.assets.map((asset) => [asset.id, assetInView(asset, asset.integration, clock)]),
  );

  const resultsByAsset = new Map<string, typeof results>();
  for (const result of results) {
    const list = resultsByAsset.get(result.assetId) ?? [];
    list.push(result);
    resultsByAsset.set(result.assetId, list);
  }

  const assets = client.assets.map((asset): ClientAsset => {
    const own = resultsByAsset.get(asset.id) ?? [];
    const view = views.get(asset.id)!;
    return {
      id: asset.id,
      name: asset.name,
      type: asset.type,
      deviceName: asset.deviceName,
      integrationName: asset.integration.name,
      vendor: asset.integration.vendor,
      currentStatus: view.status,
      unconfirmedSince: view.unconfirmedSince,
      lastResultStatus: asset.lastResultStatus,
      lastSuccessAt: asset.lastSuccessAt,
      lastResultAt: asset.lastResultAt,
      expectedFrequencyHours: asset.expectedFrequencyHours,
      slaHours: effectiveSlaHours(asset, clock.graceHours),
      staleSince: asset.staleSince,
      watched: isWatched(asset, now),
      isPaused: asset.isPaused,
      isArchived: asset.isArchived,
      mutedUntil: asset.mutedUntil,
      days: buildDayStrip(own, now),
      results: own.slice(0, RESULTS_PER_ASSET).map((r) => ({
        id: r.id,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        status: r.status,
        vendorStatusRaw: r.vendorStatusRaw,
        message: r.message,
        screenshotVerified: r.screenshotVerified,
      })),
      resultCount: own.length,
    };
  });
  assets.sort(
    (a, b) =>
      Number(b.watched) - Number(a.watched) ||
      statusSeverity(b.currentStatus) - statusSeverity(a.currentStatus) ||
      a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" }),
  );

  return {
    id: client.id,
    name: client.name,
    summary: summarizeClientHealth(
      client.assets.map((asset) => ({ ...asset, currentStatus: views.get(asset.id)!.status })),
      {
        now,
        syncFailing: client.assets.some((asset) =>
          ["retrying", "unhealthy", "stalled"].includes(
            integrationHealth(asset.integration, clock).state,
          ),
        ),
      },
    ),
    assets,
    openIncidents: incidents.map((incident) => ({
      id: incident.id,
      type: incident.type,
      assetId: incident.assetId,
      assetName: incident.asset.name,
      openedAt: incident.openedAt,
      acknowledgedAt: incident.acknowledgedAt,
      acknowledgedBy: incident.acknowledgedBy
        ? incident.acknowledgedBy.name || incident.acknowledgedBy.email
        : null,
    })),
  };
}

/**
 * Records that someone has seen an open incident and is dealing with it.
 * Owners and technicians can both do this. It does not close the incident:
 * only a completed backup does that.
 */
export async function acknowledgeIncident(
  deps: { db: Db; ip?: string | null },
  session: TenantSession,
  incidentId: string,
): Promise<ActionState> {
  const notFound: ActionState = { status: "error", message: "That incident no longer exists." };
  if (!z.uuid().safeParse(incidentId).success) return notFound;

  return deps.db.withTenant(session.tenantId, async (context) => {
    const incident = await context.tx.incident.findUnique({
      where: { id: incidentId },
      select: { id: true, type: true, closedAt: true, acknowledgedAt: true, assetId: true },
    });
    if (!incident) return notFound;
    if (incident.closedAt) {
      return { status: "error", message: "That incident has already been resolved." };
    }
    if (incident.acknowledgedAt) {
      return { status: "ok", message: "Already acknowledged." };
    }

    await context.tx.incident.update({
      where: { id: incident.id },
      data: { acknowledgedByUserId: session.userId, acknowledgedAt: new Date() },
    });
    await recordAudit(context, {
      action: "incident.acknowledged",
      actorUserId: session.userId,
      targetType: "incident",
      targetId: incident.id,
      metadata: { type: incident.type, assetId: incident.assetId },
      ip: deps.ip ?? null,
    });
    return { status: "ok", message: "Acknowledged." };
  });
}
