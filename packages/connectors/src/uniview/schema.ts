import { z } from "zod";

/**
 * Response shapes of the UniView public API (public_api-v1), from Kaseya's
 * published OpenAPI specification (apidoc-public-api.backup.net). Each list
 * endpoint returns a plain JSON array; paging totals come in response headers,
 * which the connector does not need.
 *
 * Only the fields read are declared, and unknown fields are kept, so the
 * record stored as a result's raw payload is what UniView sent. Status
 * values are read as strings, so a new one becomes "unknown" rather than a
 * failed sync.
 */
const optionalString = z.string().nullish();

/** GET /v1/customers */
export const univiewCustomerSchema = z.looseObject({
  id: z.string().min(1),
  name: optionalString,
});
export type UniviewCustomer = z.infer<typeof univiewCustomerSchema>;

/** GET /v1/appliances */
export const univiewApplianceSchema = z.looseObject({
  customer_id: optionalString,
  /** The appliance's id. */
  asset_tag: optionalString,
  name: optionalString,
  is_online: z.boolean().nullish(),
});
export type UniviewAppliance = z.infer<typeof univiewApplianceSchema>;

/** GET /v1/assets */
export const univiewAssetSchema = z.looseObject({
  customer_id: z.string().min(1),
  /** The id of the appliance protecting the asset. */
  asset_tag: optionalString,
  name: optionalString,
  type: optionalString,
  /** The asset's own unique identifier. */
  key: z.string().min(1),
});
export type UniviewAsset = z.infer<typeof univiewAssetSchema>;

/** GET /v1/backups */
export const univiewBackupSchema = z.looseObject({
  customer_id: optionalString,
  asset_tag: optionalString,
  asset_key: z.string().min(1),
  start_time: z.string().min(1),
  complete_time: optionalString,
  type: optionalString,
  status: optionalString,
  replication_status: optionalString,
});
export type UniviewBackup = z.infer<typeof univiewBackupSchema>;

/** A timestamp from UniView; one without an offset is read as UTC. Null when unreadable. */
export function parseUniviewTimestamp(value: string | null | undefined): Date | null {
  if (!value) return null;
  const withZone = /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`;
  const date = new Date(withZone);
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() < 2000) return null;
  return date;
}
