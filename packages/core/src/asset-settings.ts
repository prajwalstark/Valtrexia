/**
 * Limits on what a person may set on an asset. Shared by the forms, which
 * use them to offer only valid choices, and by the server, which enforces
 * them whatever the form sent.
 */

/**
 * `mutedUntil` for a mute with no end date. A real date far enough away to
 * behave as "never", so every rule that compares `mutedUntil` with the clock
 * keeps working unchanged.
 */
export const MUTED_INDEFINITELY = new Date("9999-12-31T00:00:00.000Z");

export function isMutedIndefinitely(mutedUntil: Date | null): boolean {
  return mutedUntil !== null && mutedUntil.getTime() >= MUTED_INDEFINITELY.getTime();
}

/** The longest mute a technician may set. Longer ones, and open-ended ones, need an owner. */
export const TECHNICIAN_MAX_MUTE_DAYS = 30;
/** The longest dated mute anyone may set. Beyond this, an owner mutes without an end date. */
export const MAX_MUTE_DAYS = 365;

export const MUTE_REASON_MIN_LENGTH = 3;
export const MUTE_REASON_MAX_LENGTH = 500;

/** Mute lengths the forms offer, in days. */
export const MUTE_DAY_CHOICES = [1, 3, 7, 14, 30, 90] as const;

/** Bounds for an asset's expected backup frequency and its SLA, in hours. One hour to one year. */
export const MIN_ASSET_HOURS = 1;
export const MAX_ASSET_HOURS = 8760;

/** A vendor-reported frequency, made safe to store: a whole number of hours within bounds. */
export function clampAssetHours(hours: number): number {
  if (!Number.isFinite(hours)) return 24;
  return Math.min(MAX_ASSET_HOURS, Math.max(MIN_ASSET_HOURS, Math.round(hours)));
}
