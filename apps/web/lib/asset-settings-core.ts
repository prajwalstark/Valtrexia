import {
  isMutedIndefinitely,
  MAX_ASSET_HOURS,
  MAX_MUTE_DAYS,
  MIN_ASSET_HOURS,
  MUTE_REASON_MAX_LENGTH,
  MUTE_REASON_MIN_LENGTH,
  MUTED_INDEFINITELY,
  TECHNICIAN_MAX_MUTE_DAYS,
} from "@valtrexia/core";
import { recordAudits, type Db, type TenantContext } from "@valtrexia/db";
import { z } from "zod";
import { count, formatDate } from "./format";
import type { TenantSession } from "./session-core";

/**
 * What a person can change about an asset: whether it is being watched
 * (mute), and what is expected of it (backup frequency and SLA). No framework
 * code, so it is tested directly against Postgres. The server actions in
 * lib/actions/assets.ts are thin wrappers.
 *
 * Who may do what, enforced here whatever the form sent:
 *   - Anyone in the workspace may mute for up to 30 days, and may unmute.
 *     Muting hides problems, so it is limited; unmuting only ever shows more.
 *   - Only owners may mute for longer or without an end date, and only owners
 *     may change the expected frequency or the SLA: those decide what counts
 *     as a problem in the first place.
 *   - Every mute needs a reason, and every change is written to the audit log
 *     in the same transaction, one entry per asset.
 *
 * `isPaused` is not set here. It is the vendor's own flag and each sync
 * overwrites it; a mute without an end date is how an owner stops watching
 * an asset for good.
 */

export type SettingsField = "duration" | "reason" | "expectedFrequencyHours" | "slaHours";

export type SettingsState =
  | { status: "idle" }
  /** `clientId` is the client whose page shows the change, read from the database. */
  | { status: "ok"; message: string; clientId: string }
  | {
      status: "error";
      message: string;
      fieldErrors?: Partial<Record<SettingsField, string>>;
    };

/** One asset, or every asset of a client that is not archived. */
export type SettingsTarget = { assetId: string } | { clientId: string };

export interface SettingsDeps {
  db: Db;
  ip?: string | null;
  /** For tests. */
  now?: Date;
}

const DAY_MS = 86_400_000;
const NOT_FOUND = "That asset no longer exists.";
const CLIENT_NOT_FOUND = "That client no longer exists.";
const CHECK_FIELDS = "Check the highlighted fields.";
const NEXT_SYNC = "Takes effect at the next sync, within a few minutes.";

const assetSelect = {
  id: true,
  name: true,
  clientId: true,
  expectedFrequencyHours: true,
  slaHours: true,
  mutedUntil: true,
  mutedReason: true,
} as const;

interface TargetAsset {
  id: string;
  name: string;
  clientId: string;
  expectedFrequencyHours: number;
  slaHours: number;
  mutedUntil: Date | null;
  mutedReason: string | null;
}

/** The assets a target names, within the caller's tenant. Null if it names nothing of theirs. */
async function loadTarget(
  { tx }: TenantContext,
  target: SettingsTarget,
): Promise<{ clientId: string; bulk: boolean; assets: TargetAsset[] } | null> {
  if ("assetId" in target) {
    if (!z.uuid().safeParse(target.assetId).success) return null;
    const asset = await tx.asset.findUnique({ where: { id: target.assetId }, select: assetSelect });
    return asset ? { clientId: asset.clientId, bulk: false, assets: [asset] } : null;
  }
  if (!z.uuid().safeParse(target.clientId).success) return null;
  const client = await tx.client.findUnique({
    where: { id: target.clientId },
    select: { id: true },
  });
  if (!client) return null;
  const assets = await tx.asset.findMany({
    where: { clientId: client.id, isArchived: false },
    select: assetSelect,
    orderBy: { name: "asc" },
  });
  return { clientId: client.id, bulk: true, assets };
}

const notFound = (target: SettingsTarget): SettingsState => ({
  status: "error",
  message: "assetId" in target ? NOT_FOUND : CLIENT_NOT_FOUND,
});

const durationSchema = z.union([
  z.literal("indefinite"),
  z.coerce.number().int().min(1).max(MAX_MUTE_DAYS),
]);
const reasonSchema = z.string().trim().min(MUTE_REASON_MIN_LENGTH).max(MUTE_REASON_MAX_LENGTH);

/**
 * Stops watching the target's assets until a date, or until someone unmutes
 * them. Their open incidents are closed in the same transaction: a muted
 * asset is not being judged, so it cannot have an open problem.
 */
export async function muteAssets(
  deps: SettingsDeps,
  session: TenantSession,
  target: SettingsTarget,
  input: { duration: unknown; reason: unknown },
): Promise<SettingsState> {
  const duration = durationSchema.safeParse(input.duration);
  const reason = reasonSchema.safeParse(input.reason);
  const fieldErrors: Partial<Record<SettingsField, string>> = {};
  if (!duration.success) fieldErrors.duration = "Choose how long to mute for.";
  if (!reason.success) {
    fieldErrors.reason = `Say why, in ${MUTE_REASON_MIN_LENGTH} to ${MUTE_REASON_MAX_LENGTH} characters.`;
  }
  if (!duration.success || !reason.success) {
    return { status: "error", message: CHECK_FIELDS, fieldErrors };
  }

  const indefinite = duration.data === "indefinite";
  if (
    session.role !== "owner" &&
    (duration.data === "indefinite" || duration.data > TECHNICIAN_MAX_MUTE_DAYS)
  ) {
    return {
      status: "error",
      message: CHECK_FIELDS,
      fieldErrors: {
        duration: `Technicians can mute for up to ${TECHNICIAN_MAX_MUTE_DAYS} days. A workspace owner can mute for longer.`,
      },
    };
  }

  const now = deps.now ?? new Date();
  const mutedUntil =
    duration.data === "indefinite"
      ? MUTED_INDEFINITELY
      : new Date(now.getTime() + duration.data * DAY_MS);

  return deps.db.withTenant(session.tenantId, async (context) => {
    const loaded = await loadTarget(context, target);
    if (!loaded) return notFound(target);
    if (loaded.assets.length === 0) {
      return { status: "error", message: "This client has no assets to mute." };
    }
    const ids = loaded.assets.map((asset) => asset.id);

    await context.tx.asset.updateMany({
      where: { id: { in: ids } },
      data: {
        mutedUntil,
        mutedReason: reason.data,
        mutedByUserId: session.userId,
        mutedAt: now,
        // Not being judged, so not past its SLA either. The next sync after
        // the mute ends works it out again.
        staleSince: null,
      },
    });
    const open = await context.tx.incident.findMany({
      // One opened after `now` by a clock ahead of ours is left for the sync.
      where: { assetId: { in: ids }, closedAt: null, openedAt: { lte: now } },
      select: { id: true, assetId: true },
    });
    if (open.length > 0) {
      await context.tx.incident.updateMany({
        where: { id: { in: open.map((incident) => incident.id) }, closedAt: null },
        data: { closedAt: now },
      });
    }
    const closedByAsset = new Map<string, number>();
    for (const incident of open) {
      closedByAsset.set(incident.assetId, (closedByAsset.get(incident.assetId) ?? 0) + 1);
    }

    await recordAudits(
      context,
      loaded.assets.map((asset) => ({
        action: "asset.muted",
        actorUserId: session.userId,
        targetType: "asset",
        targetId: asset.id,
        metadata: {
          until: indefinite ? null : mutedUntil.toISOString(),
          indefinite,
          reason: reason.data,
          previousUntil: asset.mutedUntil ? describeUntil(asset.mutedUntil) : null,
          incidentsClosed: closedByAsset.get(asset.id) ?? 0,
          clientId: loaded.clientId,
          bulk: loaded.bulk,
        },
        ip: deps.ip ?? null,
      })),
    );

    const { timeZone } = await context.tx.tenant.findUniqueOrThrow({
      where: { id: session.tenantId },
      select: { timeZone: true },
    });
    const until = indefinite
      ? "until someone unmutes it"
      : `until ${formatDate(mutedUntil, timeZone)}`;
    const closed =
      open.length > 0
        ? ` ${count(open.length, "open incident")} ${open.length === 1 ? "was" : "were"} closed.`
        : "";
    return {
      status: "ok",
      clientId: loaded.clientId,
      message: loaded.bulk
        ? `Muted ${count(ids.length, "asset")} ${until.replace("unmutes it", "unmutes them")}.${closed}`
        : `Muted ${until}.${closed}`,
    };
  });
}

/** A mute's end as it is written in audit metadata: an ISO date, or "indefinite". */
function describeUntil(mutedUntil: Date): string {
  return isMutedIndefinitely(mutedUntil) ? "indefinite" : mutedUntil.toISOString();
}

/**
 * Starts watching the target's assets again. Anyone in the workspace may do
 * this, whoever set the mute: it can only bring problems back into view.
 * Their incidents are not reopened here; the next sync judges them afresh.
 */
export async function unmuteAssets(
  deps: SettingsDeps,
  session: TenantSession,
  target: SettingsTarget,
): Promise<SettingsState> {
  return deps.db.withTenant(session.tenantId, async (context) => {
    const loaded = await loadTarget(context, target);
    if (!loaded) return notFound(target);
    const muted = loaded.assets.filter((asset) => asset.mutedUntil !== null);
    if (muted.length === 0) {
      return {
        status: "ok",
        clientId: loaded.clientId,
        message: loaded.bulk ? "No assets of this client are muted." : "It is not muted.",
      };
    }

    await context.tx.asset.updateMany({
      where: { id: { in: muted.map((asset) => asset.id) } },
      data: { mutedUntil: null, mutedReason: null, mutedByUserId: null, mutedAt: null },
    });
    await recordAudits(
      context,
      muted.map((asset) => ({
        action: "asset.unmuted",
        actorUserId: session.userId,
        targetType: "asset",
        targetId: asset.id,
        metadata: {
          previousUntil: describeUntil(asset.mutedUntil!),
          previousReason: asset.mutedReason,
          clientId: loaded.clientId,
          bulk: loaded.bulk,
        },
        ip: deps.ip ?? null,
      })),
    );

    return {
      status: "ok",
      clientId: loaded.clientId,
      message: `${loaded.bulk ? `Unmuted ${count(muted.length, "asset")}.` : "Unmuted."} Any problems reappear at the next sync, within a few minutes.`,
    };
  });
}

/** Blank means "leave as it is"; anything else must be a whole number of hours in range. */
const hoursSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.coerce.number().int().min(MIN_ASSET_HOURS).max(MAX_ASSET_HOURS).optional(),
);
const HOURS_ERROR = `Enter a whole number of hours from ${MIN_ASSET_HOURS} to ${MAX_ASSET_HOURS}.`;

/**
 * Changes how often the target's assets are expected to back up, and the
 * longest they may go without a completed backup. Owners only. The stored
 * statuses and incidents are not touched here: the next sync applies the new
 * expectations.
 */
export async function updateBackupExpectations(
  deps: SettingsDeps,
  session: TenantSession,
  target: SettingsTarget,
  input: { expectedFrequencyHours: unknown; slaHours: unknown },
): Promise<SettingsState> {
  if (session.role !== "owner") {
    return {
      status: "error",
      message: "Only workspace owners can change the expected frequency or the SLA.",
    };
  }

  const frequency = hoursSchema.safeParse(input.expectedFrequencyHours ?? undefined);
  const sla = hoursSchema.safeParse(input.slaHours ?? undefined);
  if (!frequency.success || !sla.success) {
    return {
      status: "error",
      message: CHECK_FIELDS,
      fieldErrors: {
        ...(frequency.success ? {} : { expectedFrequencyHours: HOURS_ERROR }),
        ...(sla.success ? {} : { slaHours: HOURS_ERROR }),
      },
    };
  }
  const wanted = { expectedFrequencyHours: frequency.data, slaHours: sla.data };
  if (wanted.expectedFrequencyHours === undefined && wanted.slaHours === undefined) {
    return { status: "error", message: "Enter a frequency, an SLA, or both." };
  }

  return deps.db.withTenant(session.tenantId, async (context) => {
    const loaded = await loadTarget(context, target);
    if (!loaded) return notFound(target);
    if (loaded.assets.length === 0) {
      return { status: "error", message: "This client has no assets to change." };
    }

    const changes = loaded.assets.flatMap((asset) => {
      const to = {
        expectedFrequencyHours: wanted.expectedFrequencyHours ?? asset.expectedFrequencyHours,
        slaHours: wanted.slaHours ?? asset.slaHours,
      };
      const changed =
        to.expectedFrequencyHours !== asset.expectedFrequencyHours ||
        to.slaHours !== asset.slaHours;
      return changed ? [{ asset, to }] : [];
    });
    if (changes.length === 0) {
      return { status: "ok", clientId: loaded.clientId, message: "Nothing to change." };
    }

    await context.tx.asset.updateMany({
      where: { id: { in: changes.map(({ asset }) => asset.id) } },
      data: {
        ...(wanted.expectedFrequencyHours === undefined
          ? {}
          : { expectedFrequencyHours: wanted.expectedFrequencyHours }),
        ...(wanted.slaHours === undefined ? {} : { slaHours: wanted.slaHours }),
      },
    });
    await recordAudits(
      context,
      changes.map(({ asset, to }) => ({
        action: "asset.expectations_changed",
        actorUserId: session.userId,
        targetType: "asset",
        targetId: asset.id,
        metadata: {
          from: {
            expectedFrequencyHours: asset.expectedFrequencyHours,
            slaHours: asset.slaHours,
          },
          to,
          clientId: loaded.clientId,
          bulk: loaded.bulk,
        },
        ip: deps.ip ?? null,
      })),
    );

    return {
      status: "ok",
      clientId: loaded.clientId,
      message: `${loaded.bulk ? `Changed ${count(changes.length, "asset")}.` : "Saved."} ${NEXT_SYNC}`,
    };
  });
}
