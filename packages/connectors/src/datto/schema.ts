import { z } from "zod";

/**
 * The shapes we read from Datto's REST API (https://api.datto.com/v1).
 *
 * ---------------------------------------------------------------------------
 * UNVERIFIED. None of this has been checked against a live Datto account.
 * It is written from Datto's published API description as best recalled, and
 * every field below is an assumption until a real response confirms it.
 * This file and `normalize.ts` are the only places that know Datto's field
 * names, so reconciling with reality means editing these two files and
 * their fixtures, and nothing else.
 *
 * What to check first with real keys:
 *   1. Device list: is it wrapped as `{ pagination, items }`, and do the
 *      `_page` / `_perPage` query parameters work?
 *   2. Which device field names the MSP's customer: `clientCompanyName`,
 *      `organizationName`, or something else? (See `clientOf` in connector.ts.)
 *   3. Asset list: a bare array, or the same `{ pagination, items }` wrapper?
 *   4. What identifies an asset: is `volume` present and stable?
 *   5. `backups[]`: the nesting of `backup`, `localVerification` and
 *      `advancedVerification.screenshotVerification`, and the exact status
 *      strings each one uses.
 *   6. Is `timestamp` in epoch seconds?
 *   7. Are in-progress or failed attempts listed at all, or only snapshots
 *      that exist?
 * ---------------------------------------------------------------------------
 *
 * The schemas are deliberately loose: unknown fields are kept (they belong in
 * the raw payload), and almost everything is optional. A field we guessed
 * wrong then degrades to "unknown" for that one record instead of failing a
 * whole sync.
 */

/** Epoch seconds, epoch milliseconds or an ISO 8601 string. */
const timestamp = z.union([z.number(), z.string().min(1)]);

export const dattoDeviceSchema = z.looseObject({
  serialNumber: z.string().min(1),
  name: z.string().nullish(),
  hidden: z.boolean().nullish(),
  clientCompanyName: z.string().nullish(),
  organizationId: z.union([z.number(), z.string()]).nullish(),
  organizationName: z.string().nullish(),
});
export type DattoDevice = z.infer<typeof dattoDeviceSchema>;

const verificationStatus = z.union([z.string(), z.boolean()]).nullish();

export const dattoBackupSchema = z.looseObject({
  timestamp,
  backup: z
    .looseObject({
      status: z.string().nullish(),
      errorMessage: z.string().nullish(),
    })
    .nullish(),
  localVerification: z
    .looseObject({
      status: verificationStatus,
      errors: z
        .array(
          z.looseObject({ errorType: z.string().nullish(), errorMessage: z.string().nullish() }),
        )
        .nullish(),
    })
    .nullish(),
  advancedVerification: z
    .looseObject({
      screenshotVerification: z.looseObject({ status: verificationStatus }).nullish(),
    })
    .nullish(),
});
export type DattoBackup = z.infer<typeof dattoBackupSchema>;

export const dattoAssetSchema = z.looseObject({
  name: z.string().min(1),
  /** Believed to be the asset's stable key on the device. */
  volume: z.string().nullish(),
  type: z.string().nullish(),
  agentVersion: z.string().nullish(),
  os: z.string().nullish(),
  isPaused: z.boolean().nullish(),
  isArchived: z.boolean().nullish(),
  /** Each entry is validated on its own, so one bad entry does not discard the rest. */
  backups: z.array(z.unknown()).nullish(),
});
export type DattoAsset = z.infer<typeof dattoAssetSchema>;

/** A paged list. `items` are validated one by one by the caller. */
export const dattoPageSchema = z.looseObject({
  pagination: z
    .looseObject({
      page: z.number().nullish(),
      perPage: z.number().nullish(),
      totalPages: z.number().nullish(),
    })
    .nullish(),
  items: z.array(z.unknown()),
});

/** Converts Datto's timestamp, whichever form it takes, to a Date. Null if unusable. */
export function parseDattoTimestamp(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    // Anything below this is seconds: as milliseconds it would be before 1973.
    return new Date(value < 100_000_000_000 ? value * 1000 : value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    if (/^\d+(\.\d+)?$/.test(value.trim())) return parseDattoTimestamp(Number(value));
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : new Date(parsed);
  }
  return null;
}
