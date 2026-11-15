import type { BackupStatus, Health } from "@valtrexia/core";
import type { FleetClient } from "./dashboard-core";
import { describeClient, STATUS_ORDER } from "./describe";

/**
 * The decisions behind the fleet view, as pure functions: which of the two
 * views to show on this device, and where everything goes in the 3D one.
 * Kept free of React and three.js so they can be tested directly.
 */

export type FleetViewMode = "3d" | "2d";
/** What the person chose. "auto" means they have not chosen. */
export type FleetViewPreference = "auto" | FleetViewMode;

export const PREFERENCE_COOKIE = "fleet-view";
/** Remembers whether this browser could show the 3D view last time. */
export const CAPABLE_COOKIE = "fleet-3d-ok";

export interface DeviceCapabilities {
  /** The operating system asks for reduced motion. */
  reducedMotion: boolean;
  webgl2: boolean;
  /** Logical CPU cores, when the browser reports them. */
  cores: number | null;
  /** Device memory in GB, when the browser reports it. */
  memoryGb: number | null;
  /** The browser asks sites to use less data. */
  saveData: boolean;
  /**
   * WebGL is being drawn by the CPU, not a graphics card (the browser has
   * hardware acceleration off, or the machine has none). The 3D view works
   * but is slow.
   */
  softwareRendering: boolean;
}

export type FleetViewDecision =
  | { mode: "3d"; canUse3d: true; reason: null }
  | { mode: "2d"; canUse3d: boolean; reason: string | null };

/**
 * Chooses between the 3D view and the 2D one.
 *
 * Two conditions always win, whatever the person chose, because the 3D view
 * cannot or should not run: the system asks for reduced motion, or the
 * browser has no WebGL 2.
 *
 * Otherwise an explicit choice is respected. With no choice made, a device
 * that looks low-powered, has no graphics acceleration, or asks to save
 * data gets the 2D view; the person can still switch the 3D one on.
 */
export function chooseFleetView(
  preference: FleetViewPreference,
  device: DeviceCapabilities,
): FleetViewDecision {
  if (device.reducedMotion) {
    return {
      mode: "2d",
      canUse3d: false,
      reason: "The 3D view is off because your system asks for reduced motion.",
    };
  }
  if (!device.webgl2) {
    return {
      mode: "2d",
      canUse3d: false,
      reason: "The 3D view is not available in this browser.",
    };
  }
  if (preference === "3d") return { mode: "3d", canUse3d: true, reason: null };
  if (preference === "2d") return { mode: "2d", canUse3d: true, reason: null };

  const lowPower =
    (device.cores !== null && device.cores < 4) ||
    (device.memoryGb !== null && device.memoryGb < 4);
  if (lowPower || device.saveData || device.softwareRendering) {
    return { mode: "2d", canUse3d: true, reason: null };
  }
  return { mode: "3d", canUse3d: true, reason: null };
}

export function parsePreference(value: string | undefined | null): FleetViewPreference {
  return value === "3d" || value === "2d" ? value : "auto";
}

/**
 * What the server should render before the browser has had its say, so the
 * page does not jump on load: the 3D stage only if this browser showed it
 * successfully before and the person has not switched it off.
 */
export function initialFleetView(cookies: {
  preference: string | undefined | null;
  capable: string | undefined | null;
}): FleetViewMode {
  if (parsePreference(cookies.preference) === "2d") return "2d";
  return cookies.capable === "1" ? "3d" : "2d";
}

// ---------------------------------------------------------------------------
// Layout of the 3D constellation
// ---------------------------------------------------------------------------

/** Clients drawn in the 3D view. Beyond this the scene stops being readable. */
export const MAX_NODES = 120;
/** Assets drawn around one client. */
export const MAX_SATELLITES = 28;

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
/** Distance between neighbours on the spiral, in scene units. */
const SPACING = 1.55;

export interface ConstellationNode {
  id: string;
  name: string;
  health: Health;
  /** The same one-line description the list shows. */
  description: string;
  x: number;
  z: number;
  /** Radius of the client's core, growing gently with its asset count. */
  radius: number;
  /** Radius of the ring its assets sit on. */
  orbit: number;
  /** One entry per asset drawn, worst first. */
  satellites: BackupStatus[];
  /** Watched assets not drawn because of the cap. */
  moreAssets: number;
}

export interface Constellation {
  nodes: ConstellationNode[];
  /** Clients left out because of the cap. They are all in the list below. */
  moreClients: number;
  /** Radius of the whole arrangement, for framing the camera. */
  extent: number;
}

/**
 * Places clients on a sunflower spiral, in the order given. The dashboard
 * passes them worst first, so the clients that need attention sit at the
 * centre, where the eye lands, and healthy ones spread outward.
 *
 * Deterministic: the same clients in the same order always land in the same
 * places, so the picture does not reshuffle between visits.
 */
export function buildConstellation(clients: FleetClient[]): Constellation {
  const shown = clients.slice(0, MAX_NODES);

  const nodes = shown.map((client, index): ConstellationNode => {
    const distance = SPACING * Math.sqrt(index);
    const angle = index * GOLDEN_ANGLE;

    const all = STATUS_ORDER.flatMap((status) =>
      Array.from({ length: client.summary.counts[status] }, () => status),
    );
    const radius = 0.2 + Math.min(0.22, Math.sqrt(client.summary.watched) * 0.055);

    return {
      id: client.id,
      name: client.name,
      health: client.summary.health,
      description: describeClient(client.summary),
      x: round(Math.cos(angle) * distance),
      z: round(Math.sin(angle) * distance),
      radius: round(radius),
      orbit: round(radius + 0.26),
      satellites: all.slice(0, MAX_SATELLITES),
      moreAssets: Math.max(0, all.length - MAX_SATELLITES),
    };
  });

  return {
    nodes,
    moreClients: clients.length - shown.length,
    extent: shown.length === 0 ? 1 : round(SPACING * Math.sqrt(Math.max(1, shown.length - 1)) + 1),
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
