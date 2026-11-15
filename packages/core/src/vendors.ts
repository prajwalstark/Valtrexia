/**
 * Backup vendors the platform knows about. `mock` is a development and demo
 * source only and is never offered in production.
 */
export const VENDOR_IDS = ["datto_bcdr", "kaseya_uniview", "veeam_vspc", "mock"] as const;
export type VendorId = (typeof VENDOR_IDS)[number];

export interface VendorInfo {
  id: VendorId;
  /** Name shown in the interface. */
  name: string;
  /** One line on what is monitored. */
  summary: string;
  /** `available`: a connector exists. `planned`: on the v1 roadmap, not built yet. */
  availability: "available" | "planned" | "demo";
}

export const vendors: readonly VendorInfo[] = [
  {
    id: "datto_bcdr",
    name: "Datto BCDR",
    summary: "Devices, protected agents and shares, backups, screenshot verification",
    availability: "available",
  },
  {
    id: "kaseya_uniview",
    name: "Kaseya UniView (Unitrends)",
    summary: "Appliances, protected assets and backup jobs",
    availability: "planned",
  },
  {
    id: "veeam_vspc",
    name: "Veeam Service Provider Console",
    summary: "Companies, protected workloads and job sessions",
    availability: "planned",
  },
  {
    id: "mock",
    name: "Demo data",
    summary: "Generated clients, assets and two weeks of backup history",
    availability: "demo",
  },
];

/** Vendors a tenant can see on the integrations page, excluding the demo source. */
export const realVendors: readonly VendorInfo[] = vendors.filter((v) => v.availability !== "demo");

export function getVendor(id: VendorId): VendorInfo {
  const vendor = vendors.find((v) => v.id === id);
  if (!vendor) throw new Error(`Unknown vendor: ${id}`);
  return vendor;
}

/** How often each integration is synced. */
export const SYNC_INTERVAL_MINUTES = 15;
