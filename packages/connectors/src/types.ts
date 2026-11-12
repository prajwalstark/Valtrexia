import type { BackupStatus, VendorId } from "@valtrexia/core";

/** Normalized backup status. Every connector maps its vendor's vocabulary onto this. */
export type NormalizedStatus = BackupStatus;

/** A customer of the MSP, as the vendor knows it. */
export interface VendorClient {
  /** The vendor's stable id for this customer. */
  vendorClientId: string;
  name: string;
}

/** Something the vendor protects: an agent, a share, a virtual machine. */
export interface VendorAsset {
  /** The vendor's stable id for this asset, unique within the integration. */
  vendorAssetId: string;
  vendorClientId: string;
  name: string;
  /** The vendor's asset kind, lower-cased: "agent", "share", "vm", ... */
  type: string;
  /** The appliance or host protecting the asset, when the vendor has one. */
  deviceName: string | null;
  isPaused: boolean;
  isArchived: boolean;
  /** How often the vendor is configured to back this asset up, when it says. */
  expectedFrequencyHours: number | null;
}

/** One backup attempt, as reported by the vendor. Not yet normalized. */
export interface VendorResult {
  /** Stable id for this attempt within its asset. Re-fetching must yield the same id. */
  vendorResultId: string;
  vendorAssetId: string;
  startedAt: Date;
  /** Null while the attempt is still running. */
  endedAt: Date | null;
  /** The vendor's own status value, verbatim, for display and debugging. */
  vendorStatusRaw: string;
  message: string | null;
  /** Null when screenshot verification was not attempted or is not supported. */
  screenshotVerified: boolean | null;
  /**
   * The vendor's record for this attempt, exactly as received. Stored with
   * the result and passed to `normalizeStatus`. Must not contain credentials.
   */
  rawPayload: unknown;
}

/**
 * The one interface every vendor implements.
 *
 * It is read-only by construction: there is no method that starts, stops or
 * changes a backup job, and none may be added in v1.
 *
 * Implementations handle pagination, retries with backoff and rate limiting
 * internally, and throw the errors in `./errors` rather than vendor-specific
 * ones.
 */
export interface Connector {
  readonly vendor: VendorId;

  /** Resolves if the credentials work. Throws `AuthError` if they do not. */
  testConnection(): Promise<void>;

  listClients(): Promise<VendorClient[]>;

  /** Assets of one client. `clientId` is a `vendorClientId` from `listClients`. */
  listAssets(clientId: string): Promise<VendorAsset[]>;

  /** Every backup attempt that started at or after `since`, across all clients. */
  listResults(since: Date): Promise<VendorResult[]>;

  /**
   * Maps a result's `rawPayload` to a normalized status. Pure and total: it
   * never throws, and returns "unknown" for anything it does not recognize.
   */
  normalizeStatus(raw: unknown): NormalizedStatus;
}
