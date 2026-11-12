/**
 * The mock vendor's fleet: a fixed set of clients and assets derived from a
 * seed. Everything here is a pure function of the seed, so the same seed
 * always yields the same fleet.
 */

const HOUR = 3_600_000;

/** FNV-1a. Small, stable, good enough to spread fixture data. */
export function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * How an asset's backups behave over time. Each scripted behaviour is tied to
 * the calendar (days since the epoch) rather than to "now", so history never
 * rewrites itself as time passes, while there is always something currently
 * failing, missing or warning to look at.
 */
export type Behavior =
  /** Fails every backup for 3 days out of every 9. */
  | { kind: "streak"; phase: number }
  /** Produces nothing at all for 3 days out of every 7: a missed backup. */
  | { kind: "silent"; phase: number }
  /** Backs up fine, but fails screenshot verification 1 day in 3. */
  | { kind: "screenshot"; phase: number }
  /** Discovered by the vendor but never backed up. */
  | { kind: "never" }
  /** Paused at the vendor; no backups. */
  | { kind: "paused" }
  /** Archived at the vendor; no backups. */
  | { kind: "archived" }
  /** The vendor reports a state this connector does not recognize. */
  | { kind: "unrecognized" }
  /** Each backup runs for most of a day, so one is usually in progress. */
  | { kind: "long_running" }
  /** Succeeds, with an occasional isolated failure or warning. */
  | { kind: "healthy" };

export interface MockAsset {
  id: string;
  clientId: string;
  name: string;
  type: "agent" | "share" | "vm";
  deviceName: string;
  frequencyHours: number;
  /** When in each frequency window the backup starts, in ms. */
  offsetMs: number;
  durationMs: number;
  behavior: Behavior;
}

export interface MockClient {
  id: string;
  name: string;
  short: string;
}

export interface MockCatalog {
  clients: MockClient[];
  assets: MockAsset[];
}

// Invented businesses. Any resemblance to real ones is accidental.
const CLIENTS: [name: string, short: string][] = [
  ["Harborview Dental Group", "HDG"],
  ["Kestrel Freight & Logistics", "KFL"],
  ["Marlow & Finch Architects", "MFA"],
  ["Northgate Veterinary Clinic", "NVC"],
  ["Pinecrest Family Law", "PFL"],
  ["Quillon Manufacturing", "QMF"],
  ["Redwater Credit Union", "RCU"],
  ["Saltmarsh Brewing Co.", "SBC"],
  ["Tamsin Physiotherapy", "TPH"],
  ["Underhill Property Management", "UPM"],
  ["Vantage Point Surveyors", "VPS"],
  ["Wexcombe Primary Academy", "WPA"],
];

const ASSET_NAMES: [name: string, type: MockAsset["type"]][] = [
  ["DC01", "agent"],
  ["FS01", "agent"],
  ["SQL01", "vm"],
  ["APP01", "vm"],
  ["RDS01", "agent"],
  ["Finance share", "share"],
  ["EXCH01", "vm"],
  ["Scans share", "share"],
];

/**
 * Scripted behaviours, handed to the first assets in the fleet so every
 * scenario is always present. The streak, silent and screenshot groups share
 * one schedule within the group; with their phases staggered, exactly one
 * member of each group is in its bad period on any given day.
 */
const SCRIPTED: Behavior[] = [
  { kind: "streak", phase: 0 },
  { kind: "streak", phase: 3 },
  { kind: "streak", phase: 6 },
  { kind: "silent", phase: 0 },
  { kind: "silent", phase: 2 },
  { kind: "silent", phase: 4 },
  { kind: "silent", phase: 6 },
  { kind: "screenshot", phase: 0 },
  { kind: "screenshot", phase: 1 },
  { kind: "screenshot", phase: 2 },
  { kind: "never" },
  { kind: "paused" },
  { kind: "archived" },
  { kind: "unrecognized" },
  { kind: "long_running" },
];

export function buildCatalog(seed: string): MockCatalog {
  const clients = CLIENTS.map(([name, short], i) => ({
    id: `mc-${String(i + 1).padStart(2, "0")}`,
    name,
    short,
  }));

  // Assets per client: 3 to 8, fixed by the seed.
  const slots: { client: MockClient; position: number }[] = [];
  for (const client of clients) {
    const count = 3 + (hash(`${seed}:${client.id}:count`) % 6);
    for (let position = 0; position < count; position += 1) slots.push({ client, position });
  }

  // Spread the scripted behaviours across clients instead of piling them all
  // onto the first one: visit the slots in a seed-determined order.
  const order = slots
    .map((slot, index) => ({
      index,
      key: hash(`${seed}:order:${slot.client.id}:${slot.position}`),
    }))
    .sort((a, b) => a.key - b.key || a.index - b.index)
    .map((entry) => entry.index);
  const behaviorBySlot = new Map<number, Behavior>();
  order.forEach((slotIndex, rank) => {
    behaviorBySlot.set(slotIndex, SCRIPTED[rank] ?? { kind: "healthy" });
  });

  const assets = slots.map(({ client, position }, index): MockAsset => {
    const [name, type] = ASSET_NAMES[position % ASSET_NAMES.length]!;
    const id = `${client.id}-a${position + 1}`;
    const h = hash(`${seed}:${id}`);
    const behavior = behaviorBySlot.get(index) ?? { kind: "healthy" };

    // Groups whose members must share a schedule get a fixed one. Everything
    // else varies by asset.
    const grouped =
      behavior.kind === "streak" || behavior.kind === "silent" || behavior.kind === "screenshot";
    const frequencyHours =
      grouped || behavior.kind === "long_running" ? 24 : [24, 24, 24, 12, 6][h % 5]!;
    const offsetMs = grouped ? 2 * HOUR : ((h >>> 3) % (frequencyHours * 60)) * 60_000;
    const durationMs =
      behavior.kind === "long_running" ? 20 * HOUR : (10 + ((h >>> 9) % 80)) * 60_000;

    return {
      id,
      clientId: client.id,
      name: `${client.short}-${name}`,
      type,
      deviceName: `${client.short}-BDR01`,
      frequencyHours,
      offsetMs,
      durationMs,
      behavior,
    };
  });

  return { clients, assets };
}
