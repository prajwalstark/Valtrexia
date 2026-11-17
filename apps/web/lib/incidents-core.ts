import type { Db } from "@valtrexia/db";
import { z } from "zod";
import type { TenantSession } from "./session-core";

/**
 * The incident queue: every incident in the workspace, across clients. No
 * framework code, so it is tested directly against Postgres.
 */

/**
 * - `attention`: open and nobody has acknowledged it. What a technician works from.
 * - `acknowledged`: open, and someone has said they are looking.
 * - `closed`: resolved, most recently closed first.
 */
export const INCIDENT_VIEWS = ["attention", "acknowledged", "closed"] as const;
export type IncidentView = (typeof INCIDENT_VIEWS)[number];

export const INCIDENT_TYPES = ["failed", "missed", "stale"] as const;
export type IncidentKind = (typeof INCIDENT_TYPES)[number];

export const INCIDENTS_PER_PAGE = 50;

export interface IncidentFilter {
  view: IncidentView;
  /** Only this client's incidents. */
  clientId: string | null;
  type: IncidentKind | null;
  /** From 1. */
  page: number;
}

type Param = string | string[] | undefined;
const first = (value: Param) => (Array.isArray(value) ? value[0] : value);

/**
 * Reads a filter from a page's query string. Anything unrecognized falls
 * back to the default rather than failing: these are links people edit, share
 * and bookmark.
 */
export function parseIncidentFilter(params: Record<string, Param>): IncidentFilter {
  const view = first(params.view);
  const type = first(params.type);
  const client = first(params.client);
  const page = Number(first(params.page));
  return {
    view: (INCIDENT_VIEWS as readonly string[]).includes(view ?? "")
      ? (view as IncidentView)
      : "attention",
    type: (INCIDENT_TYPES as readonly string[]).includes(type ?? "")
      ? (type as IncidentKind)
      : null,
    clientId: z.uuid().safeParse(client).success ? client! : null,
    page: Number.isInteger(page) && page >= 1 && page <= 100_000 ? page : 1,
  };
}

export interface IncidentRow {
  id: string;
  type: IncidentKind;
  assetId: string;
  assetName: string;
  clientId: string;
  clientName: string;
  openedAt: Date;
  closedAt: Date | null;
  acknowledgedAt: Date | null;
  /** Who acknowledged it: their name, or their email if they have no name. */
  acknowledgedBy: string | null;
}

export interface IncidentList {
  /** The workspace's time zone, for showing dates. */
  timeZone: string;
  /** The filter as applied: an unknown client is dropped, the page is clamped. */
  filter: IncidentFilter;
  rows: IncidentRow[];
  /** Incidents matching the filter, on every page. */
  total: number;
  pageCount: number;
  /** How many incidents each view holds, for the same client and type. */
  counts: Record<IncidentView, number>;
  /** Every client, for the filter. */
  clients: { id: string; name: string }[];
}

const viewWhere = {
  attention: { closedAt: null, acknowledgedAt: null },
  acknowledged: { closedAt: null, acknowledgedAt: { not: null } },
  closed: { closedAt: { not: null } },
} as const;

/** One page of the workspace's incidents, with the counts for each view. */
export async function listIncidents(
  deps: { db: Db },
  session: TenantSession,
  requested: IncidentFilter,
): Promise<IncidentList> {
  return deps.db.withTenant(session.tenantId, async ({ tx }) => {
    const [tenant, clients] = await Promise.all([
      tx.tenant.findUniqueOrThrow({
        where: { id: session.tenantId },
        select: { timeZone: true },
      }),
      tx.client.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    ]);
    // A client id that is not this workspace's is treated as no filter at all.
    const clientId = clients.some((client) => client.id === requested.clientId)
      ? requested.clientId
      : null;
    const scope = {
      ...(clientId ? { asset: { clientId } } : {}),
      ...(requested.type ? { type: requested.type } : {}),
    };

    const [attention, acknowledged, closed] = await Promise.all(
      INCIDENT_VIEWS.map((view) => tx.incident.count({ where: { ...scope, ...viewWhere[view] } })),
    );
    const counts = { attention: attention!, acknowledged: acknowledged!, closed: closed! };

    const total = counts[requested.view];
    const pageCount = Math.max(1, Math.ceil(total / INCIDENTS_PER_PAGE));
    const page = Math.min(requested.page, pageCount);

    const found = await tx.incident.findMany({
      where: { ...scope, ...viewWhere[requested.view] },
      // Open incidents oldest first: the longest-standing problem is at the
      // top. Closed ones by when they closed, most recent first. The id
      // settles ties, so paging never repeats or skips a row.
      orderBy:
        requested.view === "closed"
          ? [{ closedAt: "desc" }, { id: "asc" }]
          : [{ openedAt: "asc" }, { id: "asc" }],
      skip: (page - 1) * INCIDENTS_PER_PAGE,
      take: INCIDENTS_PER_PAGE,
      select: {
        id: true,
        type: true,
        assetId: true,
        openedAt: true,
        closedAt: true,
        acknowledgedAt: true,
        asset: { select: { name: true, client: { select: { id: true, name: true } } } },
        acknowledgedBy: { select: { name: true, email: true } },
      },
    });

    return {
      timeZone: tenant.timeZone,
      filter: { view: requested.view, type: requested.type, clientId, page },
      rows: found.map((incident) => ({
        id: incident.id,
        type: incident.type,
        assetId: incident.assetId,
        assetName: incident.asset.name,
        clientId: incident.asset.client.id,
        clientName: incident.asset.client.name,
        openedAt: incident.openedAt,
        closedAt: incident.closedAt,
        acknowledgedAt: incident.acknowledgedAt,
        acknowledgedBy: incident.acknowledgedBy
          ? incident.acknowledgedBy.name || incident.acknowledgedBy.email
          : null,
      })),
      total,
      pageCount,
      counts,
      clients,
    };
  });
}

/** The query string for a filter, leaving out whatever is at its default. */
export function incidentQuery(filter: Partial<IncidentFilter>): string {
  const params = new URLSearchParams();
  if (filter.view && filter.view !== "attention") params.set("view", filter.view);
  if (filter.clientId) params.set("client", filter.clientId);
  if (filter.type) params.set("type", filter.type);
  if (filter.page && filter.page > 1) params.set("page", String(filter.page));
  const query = params.toString();
  return query ? `/incidents?${query}` : "/incidents";
}
