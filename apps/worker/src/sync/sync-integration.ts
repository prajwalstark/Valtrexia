import {
  ConnectorError,
  createConnector,
  type Connector,
  type ConnectorDeps,
  type VendorAsset,
  type VendorResult,
} from "@valtrexia/connectors";
import {
  deriveCurrentStatus,
  planIncidents,
  RAISED_INCIDENT_TYPES,
  evaluateMissedBackup,
  isCompletedBackup,
  SYNC_INTERVAL_MINUTES,
  type BackupStatus,
  type MissedBackupVerdict,
  type RaisedIncidentType,
  type VendorId,
} from "@valtrexia/core";
import {
  DecryptionError,
  type KeyProvider,
  type Logger,
  type Secret,
} from "@valtrexia/core/server";
import { decryptIntegrationCredentials, Prisma, type Db } from "@valtrexia/db";

const HOUR_MS = 3_600_000;
/** How far back the first sync of an integration reaches. */
export const FIRST_SYNC_LOOKBACK_DAYS = 14;
/**
 * Later syncs re-read this much before the previous sync, so a result that
 * was still running, or that the vendor reported late, is picked up.
 */
export const SYNC_OVERLAP_HOURS = 24;
const INSERT_CHUNK = 500;

export interface SyncDeps {
  db: Db;
  keyProvider: KeyProvider;
  logger: Logger;
  /** Whether the demo vendor may be used. False in production. */
  allowMock: boolean;
  now?: () => Date;
  fetch?: typeof fetch;
  /** Overrides Datto's API root. From server configuration only, never a request. */
  dattoBaseUrl?: string;
  syncIntervalMinutes?: number;
  /** Replaces the connector registry. For tests. */
  connectorFactory?: (
    vendor: VendorId,
    credentials: Secret<unknown>,
    deps: ConnectorDeps,
  ) => Connector;
}

export interface SyncTarget {
  tenantId: string;
  integrationId: string;
}

export interface AssetVerdict {
  assetId: string;
  verdict: MissedBackupVerdict;
  currentStatus: BackupStatus;
  /** The latest result as the vendor reported it, before the missed rule. */
  lastResultStatus: BackupStatus | null;
}

export interface SyncSummary {
  clients: number;
  assets: number;
  resultsFetched: number;
  resultsCreated: number;
  resultsUpdated: number;
  /** Results the vendor returned for an asset it did not list. Dropped. */
  resultsSkipped: number;
  /** How many assets now have each current status. */
  statusCounts: Record<BackupStatus, number>;
  /** The missed-backup verdict for every asset, for the incident engine. */
  verdicts: AssetVerdict[];
  incidentsOpened: number;
  incidentsClosed: number;
  since: Date;
}

export class IntegrationNotFoundError extends Error {
  constructor() {
    super("Integration not found.");
    this.name = "IntegrationNotFoundError";
  }
}

/**
 * Pulls one integration's data from its vendor and stores it.
 *
 * Three phases, so that no database transaction is ever held open across a
 * network call:
 *   1. mark the integration as syncing and read what we need from it;
 *   2. talk to the vendor (no transaction);
 *   3. write everything in one transaction, so a failed sync leaves the
 *      previous state intact rather than half of a new one.
 *
 * Safe to run repeatedly: every write is keyed on the vendor's own ids.
 */
export async function syncIntegration(deps: SyncDeps, target: SyncTarget): Promise<SyncSummary> {
  const { db, logger } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const syncIntervalMinutes = deps.syncIntervalMinutes ?? SYNC_INTERVAL_MINUTES;
  const log = logger.child({ integrationId: target.integrationId });

  // Phase 1 ---------------------------------------------------------------
  const started = await db.withTenant(target.tenantId, async ({ tx }) => {
    const integration = await tx.integration.findUnique({
      where: { id: target.integrationId },
      select: { id: true, vendor: true, credentialsEnc: true, lastSyncAt: true },
    });
    if (!integration) throw new IntegrationNotFoundError();
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: target.tenantId },
      select: { graceHours: true },
    });
    await tx.integration.update({
      where: { id: integration.id },
      data: { syncStatus: "running", lastSyncStartedAt: now },
    });
    return { integration, graceHours: tenant.graceHours };
  });

  const since = started.integration.lastSyncAt
    ? new Date(started.integration.lastSyncAt.getTime() - SYNC_OVERLAP_HOURS * HOUR_MS)
    : new Date(now.getTime() - FIRST_SYNC_LOOKBACK_DAYS * 24 * HOUR_MS);

  try {
    // Phase 2 -------------------------------------------------------------
    const credentials = await decryptIntegrationCredentials(
      { tenantId: target.tenantId },
      deps.keyProvider,
      started.integration,
    );
    const connectorDeps: ConnectorDeps = {
      allowMock: deps.allowMock,
      logger: log,
      now: () => now,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.dattoBaseUrl ? { dattoBaseUrl: deps.dattoBaseUrl } : {}),
    };
    const connector = (deps.connectorFactory ?? createConnector)(
      started.integration.vendor,
      credentials,
      connectorDeps,
    );

    const vendorClients = await connector.listClients();
    const vendorAssets = (
      await Promise.all(vendorClients.map((client) => connector.listAssets(client.vendorClientId)))
    ).flat();
    const vendorResults = await connector.listResults(since);

    // Phase 3 -------------------------------------------------------------
    const summary = await db.withTenant(
      target.tenantId,
      async ({ tx, tenantId }) => {
        const integrationId = started.integration.id;

        // Clients and their mappings ..........................................
        const mappings = await tx.vendorClientMapping.findMany({ where: { integrationId } });
        const clientIdByVendorId = new Map(mappings.map((m) => [m.vendorClientId, m.clientId]));

        const unmapped = vendorClients.filter((c) => !clientIdByVendorId.has(c.vendorClientId));
        if (unmapped.length > 0) {
          // Reuse a client with the same name (another vendor may already
          // feed it); create the rest.
          const names = [...new Set(unmapped.map((c) => c.name))];
          const existing = await tx.client.findMany({ where: { name: { in: names } } });
          const idByName = new Map(existing.map((c) => [c.name, c.id]));
          const toCreate = names.filter((name) => !idByName.has(name));
          if (toCreate.length > 0) {
            const created = await tx.client.createManyAndReturn({
              data: toCreate.map((name) => ({ tenantId, name })),
              select: { id: true, name: true },
            });
            for (const client of created) idByName.set(client.name, client.id);
          }
          await tx.vendorClientMapping.createMany({
            data: unmapped.map((c) => ({
              tenantId,
              integrationId,
              clientId: idByName.get(c.name)!,
              vendorClientId: c.vendorClientId,
              vendorClientName: c.name,
            })),
          });
          for (const c of unmapped) clientIdByVendorId.set(c.vendorClientId, idByName.get(c.name)!);
        }
        for (const mapping of mappings) {
          const vendorName = vendorClients.find(
            (c) => c.vendorClientId === mapping.vendorClientId,
          )?.name;
          if (vendorName && vendorName !== mapping.vendorClientName) {
            // Record the vendor's new name. The client itself is not renamed:
            // its name belongs to the MSP, not to any one vendor.
            await tx.vendorClientMapping.update({
              where: { id: mapping.id },
              data: { vendorClientName: vendorName },
            });
          }
        }

        // Assets ..............................................................
        const knownAssets = await tx.asset.findMany({ where: { integrationId } });
        const assetByVendorId = new Map(knownAssets.map((a) => [a.vendorAssetId, a]));

        const placeable = vendorAssets.filter((a) => clientIdByVendorId.has(a.vendorClientId));
        const newAssets = placeable.filter((a) => !assetByVendorId.has(a.vendorAssetId));
        if (newAssets.length > 0) {
          const created = await tx.asset.createManyAndReturn({
            data: newAssets.map((a) => ({
              tenantId,
              integrationId,
              clientId: clientIdByVendorId.get(a.vendorClientId)!,
              vendorAssetId: a.vendorAssetId,
              name: a.name,
              type: a.type,
              deviceName: a.deviceName,
              isPaused: a.isPaused,
              isArchived: a.isArchived,
              // Set once, from the vendor's schedule when it reports one.
              // After that the value belongs to the MSP, who may tune it.
              expectedFrequencyHours: a.expectedFrequencyHours ?? 24,
              firstSeenAt: now,
              lastSeenAt: now,
            })),
          });
          for (const asset of created) assetByVendorId.set(asset.vendorAssetId, asset);
        }
        for (const vendorAsset of placeable) {
          const known = assetByVendorId.get(vendorAsset.vendorAssetId)!;
          const changes = assetChanges(known, vendorAsset, clientIdByVendorId);
          if (changes) {
            const updated = await tx.asset.update({ where: { id: known.id }, data: changes });
            assetByVendorId.set(updated.vendorAssetId, updated);
          }
        }
        const seenVendorIds = placeable.map((a) => a.vendorAssetId);
        if (seenVendorIds.length > 0) {
          await tx.asset.updateMany({
            where: { integrationId, vendorAssetId: { in: seenVendorIds } },
            data: { lastSeenAt: now },
          });
        }

        // Results .............................................................
        const stored = await tx.backupResult.findMany({
          where: { integrationId, startedAt: { gte: since } },
          select: {
            id: true,
            assetId: true,
            vendorResultId: true,
            status: true,
            endedAt: true,
            message: true,
            screenshotVerified: true,
          },
        });
        const storedByKey = new Map(stored.map((r) => [`${r.assetId}|${r.vendorResultId}`, r]));

        const toInsert: Prisma.BackupResultCreateManyInput[] = [];
        const fetchedByAsset = new Map<string, { status: BackupStatus; result: VendorResult }[]>();
        let resultsUpdated = 0;
        let resultsSkipped = 0;

        for (const result of vendorResults) {
          const asset = assetByVendorId.get(result.vendorAssetId);
          if (!asset) {
            resultsSkipped += 1;
            continue;
          }
          const status = connector.normalizeStatus(result.rawPayload);
          const list = fetchedByAsset.get(asset.id) ?? [];
          list.push({ status, result });
          fetchedByAsset.set(asset.id, list);

          const existing = storedByKey.get(`${asset.id}|${result.vendorResultId}`);
          if (!existing) {
            toInsert.push({
              tenantId,
              assetId: asset.id,
              integrationId,
              vendorResultId: result.vendorResultId,
              startedAt: result.startedAt,
              endedAt: result.endedAt,
              status,
              vendorStatusRaw: result.vendorStatusRaw,
              message: result.message,
              screenshotVerified: result.screenshotVerified,
              rawPayload: result.rawPayload as Prisma.InputJsonValue,
            });
          } else if (
            existing.status !== status ||
            existing.endedAt?.getTime() !== result.endedAt?.getTime() ||
            existing.message !== result.message ||
            existing.screenshotVerified !== result.screenshotVerified
          ) {
            // Typically a backup that was running last time and has finished.
            await tx.backupResult.update({
              where: { id: existing.id },
              data: {
                endedAt: result.endedAt,
                status,
                vendorStatusRaw: result.vendorStatusRaw,
                message: result.message,
                screenshotVerified: result.screenshotVerified,
                rawPayload: result.rawPayload as Prisma.InputJsonValue,
              },
            });
            resultsUpdated += 1;
          }
        }
        for (let i = 0; i < toInsert.length; i += INSERT_CHUNK) {
          await tx.backupResult.createMany({
            data: toInsert.slice(i, i + INSERT_CHUNK),
            skipDuplicates: true,
          });
        }

        // Asset status ........................................................
        const statusCounts: Record<BackupStatus, number> = {
          success: 0,
          warning: 0,
          failed: 0,
          missed: 0,
          running: 0,
          unknown: 0,
        };
        const verdicts: AssetVerdict[] = [];

        for (const asset of assetByVendorId.values()) {
          const fetched = fetchedByAsset.get(asset.id) ?? [];

          let lastResultAt = asset.lastResultAt;
          let lastResultStatus = asset.lastResultStatus;
          let lastSuccessAt = asset.lastSuccessAt;
          for (const { status, result } of fetched) {
            if (!lastResultAt || result.startedAt.getTime() >= lastResultAt.getTime()) {
              lastResultAt = result.startedAt;
              lastResultStatus = status;
            }
            if (isCompletedBackup(status)) {
              const at = result.endedAt ?? result.startedAt;
              if (!lastSuccessAt || at.getTime() > lastSuccessAt.getTime()) lastSuccessAt = at;
            }
          }

          const verdict = evaluateMissedBackup({
            now,
            asset: {
              expectedFrequencyHours: asset.expectedFrequencyHours,
              firstSeenAt: asset.firstSeenAt,
              lastCompletedAt: lastSuccessAt,
              mutedUntil: asset.mutedUntil,
              isPaused: asset.isPaused,
              isArchived: asset.isArchived,
            },
            graceHours: started.graceHours,
            // This sync has just read the vendor successfully.
            integration: { syncStatus: "ok", lastSyncAt: now },
            syncIntervalMinutes,
          });
          const currentStatus = deriveCurrentStatus(lastResultStatus, verdict);

          if (
            currentStatus !== asset.currentStatus ||
            lastResultStatus !== asset.lastResultStatus ||
            lastResultAt?.getTime() !== asset.lastResultAt?.getTime() ||
            lastSuccessAt?.getTime() !== asset.lastSuccessAt?.getTime()
          ) {
            await tx.asset.update({
              where: { id: asset.id },
              data: { currentStatus, lastResultStatus, lastResultAt, lastSuccessAt },
            });
          }
          statusCounts[currentStatus] += 1;
          verdicts.push({ assetId: asset.id, verdict, currentStatus, lastResultStatus });
        }

        // Incidents ...........................................................
        // In the same transaction as the statuses they follow from, so the two
        // can never disagree.
        const openIncidents = await tx.incident.findMany({
          where: {
            closedAt: null,
            type: { in: [...RAISED_INCIDENT_TYPES] },
            asset: { integrationId },
          },
          select: { id: true, assetId: true, type: true },
        });
        const openByAsset = new Map<string, Map<RaisedIncidentType, string>>();
        for (const incident of openIncidents) {
          const types = openByAsset.get(incident.assetId) ?? new Map<RaisedIncidentType, string>();
          types.set(incident.type as RaisedIncidentType, incident.id);
          openByAsset.set(incident.assetId, types);
        }

        const toOpen: Prisma.IncidentCreateManyInput[] = [];
        const toClose: string[] = [];
        for (const entry of verdicts) {
          const open = openByAsset.get(entry.assetId);
          const plan = planIncidents({
            lastResultStatus: entry.lastResultStatus,
            verdict: entry.verdict,
            open: new Set(open?.keys() ?? []),
          });
          for (const type of plan.open) {
            toOpen.push({ tenantId, assetId: entry.assetId, type, openedAt: now });
          }
          for (const type of plan.close) toClose.push(open!.get(type)!);
        }
        if (toOpen.length > 0) await tx.incident.createMany({ data: toOpen });
        if (toClose.length > 0) {
          await tx.incident.updateMany({
            where: { id: { in: toClose }, closedAt: null },
            data: { closedAt: now },
          });
        }

        await tx.integration.update({
          where: { id: integrationId },
          data: { syncStatus: "ok", lastSyncAt: now, lastSyncError: null },
        });

        return {
          clients: vendorClients.length,
          assets: assetByVendorId.size,
          resultsFetched: vendorResults.length,
          resultsCreated: toInsert.length,
          resultsUpdated,
          resultsSkipped,
          statusCounts,
          verdicts,
          incidentsOpened: toOpen.length,
          incidentsClosed: toClose.length,
          since,
        } satisfies SyncSummary;
      },
      { timeoutMs: 120_000, maxWaitMs: 15_000 },
    );

    log.info(
      {
        clients: summary.clients,
        assets: summary.assets,
        resultsCreated: summary.resultsCreated,
        resultsUpdated: summary.resultsUpdated,
        resultsSkipped: summary.resultsSkipped,
        incidentsOpened: summary.incidentsOpened,
        incidentsClosed: summary.incidentsClosed,
      },
      "sync finished",
    );
    return summary;
  } catch (error) {
    log.error({ err: error }, "sync failed");
    await db
      .withTenant(target.tenantId, ({ tx }) =>
        tx.integration.update({
          where: { id: target.integrationId },
          data: { syncStatus: "error", lastSyncError: describeFailure(error) },
        }),
      )
      .catch((secondary: unknown) => {
        log.error({ err: secondary }, "could not record the sync failure");
      });
    throw error;
  }
}

/**
 * The message stored on the integration and shown in the interface. Only
 * messages we wrote ourselves are passed through; anything else could carry
 * details that do not belong on a screen.
 */
export function describeFailure(error: unknown): string {
  if (error instanceof ConnectorError) return error.message;
  if (error instanceof DecryptionError) {
    return "The saved credentials could not be read. Enter them again.";
  }
  return "The sync failed unexpectedly. It will be retried.";
}

interface KnownAsset {
  name: string;
  type: string;
  deviceName: string | null;
  isPaused: boolean;
  isArchived: boolean;
  clientId: string;
}

/** The fields of a known asset that the vendor now reports differently, if any. */
function assetChanges(
  known: KnownAsset,
  vendor: VendorAsset,
  clientIdByVendorId: Map<string, string>,
): Partial<KnownAsset> | null {
  const next: KnownAsset = {
    name: vendor.name,
    type: vendor.type,
    deviceName: vendor.deviceName,
    isPaused: vendor.isPaused,
    isArchived: vendor.isArchived,
    clientId: clientIdByVendorId.get(vendor.vendorClientId) ?? known.clientId,
  };
  const changed = (Object.keys(next) as (keyof KnownAsset)[]).filter(
    (key) => next[key] !== known[key],
  );
  if (changed.length === 0) return null;
  return Object.fromEntries(changed.map((key) => [key, next[key]])) as Partial<KnownAsset>;
}
