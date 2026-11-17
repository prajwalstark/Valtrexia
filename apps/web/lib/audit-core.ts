import { getVendor, VENDOR_IDS, type VendorId } from "@valtrexia/core";
import type { Db } from "@valtrexia/db";
import { count, formatDate } from "./format";
import type { TenantSession } from "./session-core";

/**
 * The audit log as owners read it. No framework code, so it is tested
 * directly against Postgres.
 *
 * Entries are written by the code that makes each change, in the same
 * transaction. This module only reads them and puts them into words.
 */

export const AUDIT_CATEGORIES = {
  all: { label: "Everything", prefixes: [] },
  assets: { label: "Assets", prefixes: ["asset."] },
  incidents: { label: "Incidents", prefixes: ["incident."] },
  integrations: { label: "Integrations", prefixes: ["integration."] },
  notifications: { label: "Notifications", prefixes: ["notification_channel."] },
  people: { label: "People", prefixes: ["user."] },
  workspace: { label: "Workspace", prefixes: ["workspace.", "tenant."] },
} as const satisfies Record<string, { label: string; prefixes: readonly string[] }>;
export type AuditCategory = keyof typeof AUDIT_CATEGORIES;

export const AUDIT_ENTRIES_PER_PAGE = 50;

export interface AuditFilter {
  category: AuditCategory;
  /** From 1. */
  page: number;
}

type Param = string | string[] | undefined;
const first = (value: Param) => (Array.isArray(value) ? value[0] : value);

/** Reads a filter from the page's query string, falling back to the default for anything unrecognized. */
export function parseAuditFilter(params: Record<string, Param>): AuditFilter {
  const category = first(params.category) ?? "";
  const page = Number(first(params.page));
  return {
    category: Object.hasOwn(AUDIT_CATEGORIES, category) ? (category as AuditCategory) : "all",
    page: Number.isInteger(page) && page >= 1 && page <= 100_000 ? page : 1,
  };
}

export function auditQuery(filter: Partial<AuditFilter>): string {
  const params = new URLSearchParams();
  if (filter.category && filter.category !== "all") params.set("category", filter.category);
  if (filter.page && filter.page > 1) params.set("page", String(filter.page));
  const query = params.toString();
  return query ? `/audit?${query}` : "/audit";
}

export interface AuditRow {
  id: string;
  at: Date;
  /** The person's name, or their email; "System" for something no person did. */
  actor: string;
  /** The stored action, for example `asset.muted`. */
  action: string;
  /** What happened, in a sentence. */
  summary: string;
  ip: string | null;
}

export type AuditList =
  | { status: "forbidden" }
  | {
      status: "ok";
      timeZone: string;
      filter: AuditFilter;
      rows: AuditRow[];
      total: number;
      pageCount: number;
    };

/** What an entry's target was called, looked up for the entries on a page. */
export interface AuditNames {
  assets: ReadonlyMap<string, string>;
  integrations: ReadonlyMap<string, string>;
  users: ReadonlyMap<string, string>;
}

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const number = (value: unknown): number | null => (typeof value === "number" ? value : null);
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const vendorName = (value: unknown): string | null =>
  typeof value === "string" && (VENDOR_IDS as readonly string[]).includes(value)
    ? getVendor(value as VendorId).name
    : null;
const zone = (value: unknown) => (text(value) ?? "?").replaceAll("_", " ");

const TEST_OUTCOME: Record<string, string> = {
  ok: "it succeeded",
  rejected: "the vendor rejected the keys",
  rate_limited: "the vendor was rate limiting",
  unreachable: "the vendor could not be reached",
  vendor_error: "the vendor returned an error",
  failed: "it failed",
};

/**
 * One audit entry as a sentence. Written from the stored metadata, with the
 * names of things looked up; something since deleted is described as such
 * rather than left out. An action this does not know is shown by its stored
 * name, so a new kind of entry is never hidden.
 */
export function describeAuditEntry(
  entry: { action: string; targetId: string | null; metadata: unknown },
  names: AuditNames,
  timeZone: string,
): string {
  const meta = record(entry.metadata);
  const id = entry.targetId ?? "";
  const asset = names.assets.get(id) ?? "an asset since removed";
  const integration =
    names.integrations.get(id) ?? text(meta.name) ?? "an integration since removed";
  const user = names.users.get(id) ?? "someone since removed";
  const forAll = meta.bulk === true ? " (with all of its client’s assets)" : "";

  switch (entry.action) {
    case "asset.muted": {
      const until = text(meta.until);
      const when =
        meta.indefinite === true || until === null
          ? "with no end date"
          : `until ${formatDate(new Date(until), timeZone)}`;
      const reason = text(meta.reason);
      const closed = number(meta.incidentsClosed) ?? 0;
      return `Muted ${asset} ${when}${forAll}${reason ? `: “${reason}”` : ""}${
        closed > 0 ? `. ${count(closed, "open incident")} closed` : ""
      }`;
    }
    case "asset.unmuted":
      return `Unmuted ${asset}${forAll}`;
    case "asset.expectations_changed": {
      const from = record(meta.from);
      const to = record(meta.to);
      const parts: string[] = [];
      if (from.expectedFrequencyHours !== to.expectedFrequencyHours) {
        parts.push(
          `expected every ${String(from.expectedFrequencyHours)} → ${String(to.expectedFrequencyHours)} hours`,
        );
      }
      if (from.slaHours !== to.slaHours) {
        parts.push(`SLA ${String(from.slaHours)} → ${String(to.slaHours)} hours`);
      }
      return `Changed ${asset}${forAll}: ${parts.join(", ") || "no values differed"}`;
    }
    case "incident.acknowledged": {
      const type = text(meta.type);
      const assetName = names.assets.get(text(meta.assetId) ?? "") ?? "an asset since removed";
      return `Acknowledged ${type ? `a ${type} incident` : "an incident"} on ${assetName}`;
    }
    case "integration.created": {
      const name = text(meta.name) ?? integration;
      const vendor = vendorName(meta.vendor);
      // The vendor is added only when the name does not already say it.
      return `Connected ${name}${vendor && vendor !== name ? ` (${vendor})` : ""}`;
    }
    case "integration.credentials_replaced":
      return `Replaced the keys of ${integration}`;
    case "integration.deleted": {
      const removed = number(meta.assetsRemoved);
      return `Disconnected ${text(meta.name) ?? integration}${
        removed === null ? "" : `, removing ${count(removed, "asset")} and their history`
      }`;
    }
    case "integration.connection_tested": {
      const outcome = TEST_OUTCOME[text(meta.outcome) ?? ""] ?? "the outcome was not recorded";
      const what = entry.targetId
        ? `the connection to ${integration}`
        : `new ${vendorName(meta.vendor) ?? "vendor"} keys before saving them`;
      return `Tested ${what}: ${outcome}`;
    }
    case "user.joined":
      return `${user} joined as ${text(meta.role) ?? "a member"}`;
    case "user.reactivated":
      return `${user} rejoined as ${text(meta.role) ?? "a member"}`;
    case "user.deactivated":
      return `${user} was removed from the workspace`;
    case "user.role_changed":
      return `${user} changed from ${text(meta.from) ?? "?"} to ${text(meta.to) ?? "?"}`;
    case "notification_channel.created": {
      const host = text(meta.host);
      const recipients = number(meta.recipients);
      const where = host
        ? `, sending to ${host}`
        : recipients !== null
          ? `, sending to ${count(recipients, "address", "addresses")}`
          : "";
      return `Added the ${text(meta.type) ?? "notification"} channel ${text(meta.name) ?? "?"}${where}`;
    }
    case "notification_channel.enabled":
      return `Turned on the ${text(meta.type) ?? "notification"} channel ${text(meta.name) ?? "?"}`;
    case "notification_channel.disabled":
      return `Turned off the ${text(meta.type) ?? "notification"} channel ${text(meta.name) ?? "?"}`;
    case "notification_channel.deleted":
      return `Deleted the ${text(meta.type) ?? "notification"} channel ${text(meta.name) ?? "?"}`;
    case "tenant.provisioned":
      return "Created the workspace";
    case "workspace.settings_changed": {
      const from = record(meta.from);
      const to = record(meta.to);
      const parts: string[] = [];
      if (from.timeZone !== to.timeZone) {
        parts.push(`the time zone from ${zone(from.timeZone)} to ${zone(to.timeZone)}`);
      }
      if (from.graceHours !== to.graceHours) {
        parts.push(
          `the grace period from ${String(from.graceHours)} to ${count(number(to.graceHours) ?? 0, "hour")}`,
        );
      }
      return `Changed ${parts.join(" and ") || "the workspace settings"}`;
    }
    default:
      return entry.action;
  }
}

/**
 * One page of the audit log, newest first. Owners only: it shows who did
 * what across the whole workspace, including each person's IP address.
 */
export async function listAuditLog(
  deps: { db: Db },
  session: TenantSession,
  requested: AuditFilter,
): Promise<AuditList> {
  if (session.role !== "owner") return { status: "forbidden" };

  return deps.db.withTenant(session.tenantId, async ({ tx }) => {
    const { timeZone } = await tx.tenant.findUniqueOrThrow({
      where: { id: session.tenantId },
      select: { timeZone: true },
    });
    const prefixes = AUDIT_CATEGORIES[requested.category].prefixes;
    const where =
      prefixes.length > 0
        ? { OR: prefixes.map((prefix) => ({ action: { startsWith: prefix } })) }
        : {};

    const total = await tx.auditLog.count({ where });
    const pageCount = Math.max(1, Math.ceil(total / AUDIT_ENTRIES_PER_PAGE));
    const page = Math.min(requested.page, pageCount);

    const entries = await tx.auditLog.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      skip: (page - 1) * AUDIT_ENTRIES_PER_PAGE,
      take: AUDIT_ENTRIES_PER_PAGE,
      select: {
        id: true,
        createdAt: true,
        action: true,
        targetType: true,
        targetId: true,
        metadata: true,
        ip: true,
        actor: { select: { name: true, email: true } },
      },
    });

    // Names for the things these entries are about, in three queries however
    // many entries there are.
    const ids = (type: string) => [
      ...new Set(entries.flatMap((e) => (e.targetType === type && e.targetId ? [e.targetId] : []))),
    ];
    const assetIds = [
      ...new Set([
        ...ids("asset"),
        ...entries.flatMap((e) => {
          const assetId = record(e.metadata).assetId;
          return typeof assetId === "string" ? [assetId] : [];
        }),
      ]),
    ].filter((value) => /^[0-9a-f-]{36}$/i.test(value));
    const [assets, integrations, users] = await Promise.all([
      tx.asset.findMany({ where: { id: { in: assetIds } }, select: { id: true, name: true } }),
      tx.integration.findMany({
        where: { id: { in: ids("integration") } },
        select: { id: true, name: true },
      }),
      tx.user.findMany({
        where: { id: { in: ids("user") } },
        select: { id: true, name: true, email: true },
      }),
    ]);
    const names: AuditNames = {
      assets: new Map(assets.map((a) => [a.id, a.name])),
      integrations: new Map(integrations.map((i) => [i.id, i.name])),
      users: new Map(users.map((u) => [u.id, u.name || u.email])),
    };

    return {
      status: "ok",
      timeZone,
      filter: { category: requested.category, page },
      rows: entries.map((entry) => ({
        id: entry.id,
        at: entry.createdAt,
        actor: entry.actor ? entry.actor.name || entry.actor.email : "System",
        action: entry.action,
        summary: describeAuditEntry(entry, names, timeZone),
        ip: entry.ip,
      })),
      total,
      pageCount,
    };
  });
}
