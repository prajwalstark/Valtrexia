import { MAX_GRACE_HOURS, MIN_GRACE_HOURS } from "@valtrexia/core";
import { recordAudit, type Db } from "@valtrexia/db";
import { z } from "zod";
import { isTimeZone } from "./format";
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
  return deps.db.withTenant(session.tenantId, ({ tx }) =>
    tx.tenant.findUniqueOrThrow({
      where: { id: session.tenantId },
      select: { name: true, timeZone: true, graceHours: true },
    }),
  );
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
