import { brand } from "@valtrexia/core";
import { recordAudit, type Db, type TenantTx } from "@valtrexia/db";
import { RateLimiterUnavailableError, type RateLimiter } from "./rate-limit";
import type { TenantSession } from "./session-core";

/**
 * A workspace's data, for its owners to take with them: one JSON document,
 * written a page at a time so a large workspace never sits in memory.
 *
 * Every column is named here. A column added to a table later is not
 * exported until someone adds it on purpose, so a new secret cannot slip
 * out. Never exported: vendor credentials (even encrypted), webhook URLs and
 * signing secrets, and the raw records vendors sent with each result.
 */

export const EXPORT_FORMAT = `${brand.name.toLowerCase()}-workspace-export`;
export const EXPORT_VERSION = 1;
const DEFAULT_PAGE = 500;

export interface ExportDeps {
  db: Db;
  now?: () => Date;
  /** Rows per page. Smaller in tests, to exercise paging. */
  pageSize?: number;
}

type Row = Record<string, unknown> & { id: string };

/** The document's sections, in order, each read in pages ordered by id. */
const SECTIONS: {
  key: string;
  read: (tx: TenantTx, after: string | null, take: number) => Promise<Row[]>;
}[] = [
  {
    key: "members",
    read: (tx, after, take) =>
      tx.user.findMany({
        ...page(after, take),
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          deactivatedAt: true,
          createdAt: true,
        },
      }),
  },
  {
    key: "integrations",
    read: (tx, after, take) =>
      tx.integration.findMany({
        ...page(after, take),
        select: {
          id: true,
          vendor: true,
          name: true,
          // The last characters of a key: what the integrations page shows.
          credentialHint: true,
          syncStatus: true,
          lastSyncAt: true,
          lastSyncError: true,
          createdAt: true,
        },
      }),
  },
  {
    key: "clients",
    read: (tx, after, take) =>
      tx.client.findMany({
        ...page(after, take),
        select: { id: true, name: true, createdAt: true },
      }),
  },
  {
    key: "vendorClientMappings",
    read: (tx, after, take) =>
      tx.vendorClientMapping.findMany({
        ...page(after, take),
        select: {
          id: true,
          integrationId: true,
          clientId: true,
          vendorClientId: true,
          vendorClientName: true,
        },
      }),
  },
  {
    key: "assets",
    read: (tx, after, take) =>
      tx.asset.findMany({
        ...page(after, take),
        select: {
          id: true,
          clientId: true,
          integrationId: true,
          vendorAssetId: true,
          name: true,
          type: true,
          deviceName: true,
          expectedFrequencyHours: true,
          slaHours: true,
          mutedUntil: true,
          mutedReason: true,
          mutedByUserId: true,
          mutedAt: true,
          isPaused: true,
          isArchived: true,
          firstSeenAt: true,
          lastSeenAt: true,
          lastResultAt: true,
          lastSuccessAt: true,
          currentStatus: true,
          staleSince: true,
        },
      }),
  },
  {
    key: "backupResults",
    read: (tx, after, take) =>
      tx.backupResult.findMany({
        ...page(after, take),
        select: {
          id: true,
          assetId: true,
          vendorResultId: true,
          startedAt: true,
          endedAt: true,
          status: true,
          vendorStatusRaw: true,
          message: true,
          screenshotVerified: true,
        },
      }),
  },
  {
    key: "incidents",
    read: (tx, after, take) =>
      tx.incident.findMany({
        ...page(after, take),
        select: {
          id: true,
          assetId: true,
          type: true,
          openedAt: true,
          closedAt: true,
          acknowledgedByUserId: true,
          acknowledgedAt: true,
        },
      }),
  },
  {
    key: "notificationChannels",
    read: async (tx, after, take) => {
      const rows = await tx.notificationChannel.findMany({
        ...page(after, take),
        select: {
          id: true,
          type: true,
          name: true,
          enabled: true,
          incidentTypes: true,
          notifyOpened: true,
          notifyClosed: true,
          notifyIntegrationHealth: true,
          notifyMonthlyReport: true,
          config: true,
          createdAt: true,
        },
      });
      // A webhook's host and an email channel's recipients, as the
      // notifications page shows them. Never the URL or the signing secret.
      return rows.map(({ config, ...row }) => ({
        ...row,
        destination: destinationOf(row.type, config),
      }));
    },
  },
  {
    key: "auditLog",
    read: (tx, after, take) =>
      tx.auditLog.findMany({
        ...page(after, take),
        select: {
          id: true,
          actorType: true,
          actorUserId: true,
          action: true,
          targetType: true,
          targetId: true,
          metadata: true,
          ip: true,
          createdAt: true,
        },
      }),
  },
];

function page(after: string | null, take: number) {
  return { where: after ? { id: { gt: after } } : {}, orderBy: { id: "asc" as const }, take };
}

function destinationOf(type: string, config: unknown): Record<string, unknown> {
  const value = (config ?? {}) as { host?: unknown; recipients?: unknown };
  if (type === "webhook") return { host: typeof value.host === "string" ? value.host : null };
  return {
    recipients: Array.isArray(value.recipients)
      ? value.recipients.filter((r) => typeof r === "string")
      : [],
  };
}

/**
 * The export, as pieces of JSON text in order. Each page is read in its own
 * short transaction, so the document reflects the workspace over the few
 * seconds it takes to write, not a single instant.
 */
export async function* exportWorkspace(
  deps: ExportDeps,
  session: TenantSession,
): AsyncGenerator<string> {
  const take = deps.pageSize ?? DEFAULT_PAGE;
  const now = (deps.now ?? (() => new Date()))();
  const workspace = await deps.db.withTenant(session.tenantId, ({ tx }) =>
    tx.tenant.findUniqueOrThrow({
      where: { id: session.tenantId },
      select: { name: true, timeZone: true, graceHours: true, createdAt: true },
    }),
  );
  yield `{"format":${JSON.stringify(EXPORT_FORMAT)},"version":${EXPORT_VERSION},"exportedAt":${JSON.stringify(now.toISOString())},"workspace":${JSON.stringify(workspace)}`;

  for (const section of SECTIONS) {
    yield `,${JSON.stringify(section.key)}:[`;
    let after: string | null = null;
    let first = true;
    for (;;) {
      const rows: Row[] = await deps.db.withTenant(session.tenantId, ({ tx }) =>
        section.read(tx, after, take),
      );
      for (const row of rows) {
        yield (first ? "" : ",") + JSON.stringify(row);
        first = false;
      }
      if (rows.length < take) break;
      after = rows[rows.length - 1]!.id;
    }
    yield "]";
  }
  yield `,"notLeftOut":${JSON.stringify(
    "Every record of this workspace is included except vendor credentials, webhook URLs and signing secrets, and the raw records vendors sent with each backup result.",
  )}}\n`;
}

export type ExportStart =
  | { kind: "refused"; status: 403 | 429 | 503; message: string }
  | { kind: "ok"; filename: string; chunks: AsyncGenerator<string> };

/**
 * Starts an export for an owner: at most one per workspace per hour, and
 * written to the audit log before the first byte is sent.
 */
export async function startWorkspaceExport(
  deps: ExportDeps & { limiter: RateLimiter; ip?: string | null },
  session: TenantSession,
): Promise<ExportStart> {
  if (session.role !== "owner") {
    return {
      kind: "refused",
      status: 403,
      message: "Only workspace owners can export the workspace's data.",
    };
  }
  let allowed: boolean;
  try {
    allowed = await deps.limiter.take(session.tenantId);
  } catch (error) {
    if (!(error instanceof RateLimiterUnavailableError)) throw error;
    return {
      kind: "refused",
      status: 503,
      message: "Exports are unavailable for a moment. Try again shortly.",
    };
  }
  if (!allowed) {
    return {
      kind: "refused",
      status: 429,
      message: "This workspace was exported in the last hour. Use that file, or try again later.",
    };
  }
  const now = (deps.now ?? (() => new Date()))();
  await deps.db.withTenant(session.tenantId, (context) =>
    recordAudit(context, {
      action: "workspace.exported",
      actorUserId: session.userId,
      targetType: "tenant",
      targetId: session.tenantId,
      ip: deps.ip ?? null,
    }),
  );
  return {
    kind: "ok",
    filename: `${brand.name.toLowerCase()}-export-${now.toISOString().slice(0, 10)}.json.gz`,
    chunks: exportWorkspace({ ...deps, now: () => now }, session),
  };
}

/** Text pieces to a gzipped byte stream, read only as fast as the client takes it. */
export function gzipStream(
  chunks: AsyncGenerator<string>,
): ReadableStream<Uint8Array<ArrayBuffer>> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
      const { value, done } = await chunks.next();
      if (done) controller.close();
      else controller.enqueue(encoder.encode(value));
    },
    async cancel() {
      await chunks.return(undefined);
    },
  }).pipeThrough(new CompressionStream("gzip"));
}
