import { MAX_GRACE_HOURS, MIN_GRACE_HOURS } from "@valtrexia/core";
import {
  cancelTenantDeletion,
  getPendingDeletion,
  recordAudit,
  requestTenantDeletion,
  type Db,
  type PendingDeletion,
} from "@valtrexia/db";
import { z } from "zod";
import { formatDate, isTimeZone } from "./format";
import type { TenantSession } from "./session-core";

/**
 * Settings that belong to the whole workspace. No framework code, so it is
 * tested directly against Postgres.
 */

export interface WorkspaceSettings {
  name: string;
  /** IANA time zone dates are shown in. Everything is stored in UTC. */
  timeZone: string;
  /** Hours allowed past an asset's expected frequency before a backup counts as missed. */
  graceHours: number;
  /** Set while the workspace is waiting to be deleted. */
  deletion: PendingDeletion | null;
}

export type WorkspaceField = "timeZone" | "graceHours";

export type WorkspaceState =
  | { status: "idle" }
  | { status: "ok"; message: string }
  | { status: "error"; message: string; fieldErrors?: Partial<Record<WorkspaceField, string>> };

/** The workspace's settings. Anyone in the workspace may read them. */
export async function getWorkspaceSettings(
  deps: { db: Db },
  session: TenantSession,
): Promise<WorkspaceSettings> {
  return deps.db.withTenant(session.tenantId, async (context) => {
    const settings = await context.tx.tenant.findUniqueOrThrow({
      where: { id: session.tenantId },
      select: { name: true, timeZone: true, graceHours: true },
    });
    return { ...settings, deletion: await getPendingDeletion(context) };
  });
}

const graceSchema = z.coerce.number().int().min(MIN_GRACE_HOURS).max(MAX_GRACE_HOURS);

/**
 * Changes the time zone and the grace period. Owners only: the grace period
 * decides when a backup counts as missed for every asset in the workspace.
 *
 * The time zone changes only how dates are shown and where one day ends and
 * the next begins. Nothing stored is rewritten. The grace period applies to
 * what pages show straight away and to incidents from the next sync.
 */
export async function updateWorkspaceSettings(
  deps: { db: Db; ip?: string | null },
  session: TenantSession,
  input: { timeZone: unknown; graceHours: unknown },
): Promise<WorkspaceState> {
  if (session.role !== "owner") {
    return { status: "error", message: "Only workspace owners can change these settings." };
  }

  const fieldErrors: Partial<Record<WorkspaceField, string>> = {};
  if (!isTimeZone(input.timeZone)) fieldErrors.timeZone = "Choose a time zone from the list.";
  // Blank or absent is not zero: an empty field must not silently remove
  // the grace period. (Coercion alone would turn both into 0.)
  const blank =
    input.graceHours === null ||
    input.graceHours === undefined ||
    (typeof input.graceHours === "string" && input.graceHours.trim() === "");
  const grace = graceSchema.safeParse(blank ? Number.NaN : input.graceHours);
  if (!grace.success) {
    fieldErrors.graceHours = `Enter a whole number of hours from ${MIN_GRACE_HOURS} to ${MAX_GRACE_HOURS}.`;
  }
  if (!isTimeZone(input.timeZone) || !grace.success) {
    return { status: "error", message: "Check the highlighted fields.", fieldErrors };
  }
  const to = { timeZone: input.timeZone, graceHours: grace.data };

  return deps.db.withTenant(session.tenantId, async (context) => {
    const from = await context.tx.tenant.findUniqueOrThrow({
      where: { id: session.tenantId },
      select: { timeZone: true, graceHours: true },
    });
    if (from.timeZone === to.timeZone && from.graceHours === to.graceHours) {
      return { status: "ok", message: "Nothing to change." };
    }

    await context.tx.tenant.update({ where: { id: session.tenantId }, data: to });
    await recordAudit(context, {
      action: "workspace.settings_changed",
      actorUserId: session.userId,
      targetType: "tenant",
      targetId: session.tenantId,
      metadata: { from, to },
      ip: deps.ip ?? null,
    });

    return {
      status: "ok",
      message:
        from.graceHours === to.graceHours
          ? "Saved."
          : "Saved. Incidents follow the new grace period from the next sync, within a few minutes.",
    };
  });
}

export type DeletionState =
  | { status: "idle" }
  | { status: "ok"; message: string }
  | { status: "error"; message: string; fieldError?: string };

/**
 * Marks the workspace for deletion after the hold. Owners only, and only with
 * the workspace's name typed out, so it cannot happen by a stray click.
 * Nothing is deleted until the hold has passed, and it can be cancelled until then.
 */
export async function requestWorkspaceDeletion(
  deps: { db: Db; ip?: string | null; now?: () => Date },
  session: TenantSession,
  confirmName: unknown,
): Promise<DeletionState> {
  if (session.role !== "owner") {
    return { status: "error", message: "Only workspace owners can delete the workspace." };
  }
  return deps.db.withTenant(session.tenantId, async (context) => {
    const { name, timeZone } = await context.tx.tenant.findUniqueOrThrow({
      where: { id: session.tenantId },
      select: { name: true, timeZone: true },
    });
    if (typeof confirmName !== "string" || confirmName.trim() !== name) {
      return {
        status: "error",
        message: "Nothing was changed.",
        fieldError: "Type the workspace’s name exactly as shown.",
      };
    }
    const { pending, changed } = await requestTenantDeletion(context, {
      reason: "owner_request",
      now: (deps.now ?? (() => new Date()))(),
      actorUserId: session.userId,
      ip: deps.ip ?? null,
    });
    const on = formatDate(pending.deleteAfter, timeZone);
    return {
      status: "ok",
      message: changed
        ? `The workspace and all its data will be deleted on ${on}. Syncing and notifications have stopped.`
        : `The workspace was already scheduled for deletion on ${on}.`,
    };
  });
}

/** Cancels a pending deletion. Owners only. */
export async function cancelWorkspaceDeletion(
  deps: { db: Db; ip?: string | null },
  session: TenantSession,
): Promise<DeletionState> {
  if (session.role !== "owner") {
    return { status: "error", message: "Only workspace owners can cancel a deletion." };
  }
  const cancelled = await deps.db.withTenant(session.tenantId, (context) =>
    cancelTenantDeletion(context, { actorUserId: session.userId, ip: deps.ip ?? null }),
  );
  return cancelled
    ? { status: "ok", message: "Deletion cancelled. Syncing resumes within a few minutes." }
    : { status: "ok", message: "The workspace was not scheduled for deletion." };
}
