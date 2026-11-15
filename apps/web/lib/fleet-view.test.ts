import { summarizeClientHealth, type BackupStatus } from "@valtrexia/core";
import { describe, expect, it } from "vitest";
import type { FleetClient } from "./dashboard-core";
import {
  buildConstellation,
  chooseFleetView,
  initialFleetView,
  MAX_NODES,
  MAX_SATELLITES,
  parsePreference,
  type DeviceCapabilities,
} from "./fleet-view";

const capable: DeviceCapabilities = {
  reducedMotion: false,
  webgl2: true,
  cores: 8,
  memoryGb: 8,
  saveData: false,
  softwareRendering: false,
};
const NOW = new Date("2026-11-12T12:00:00Z");

function client(name: string, statuses: BackupStatus[]): FleetClient {
  return {
    id: `id-${name}`,
    name,
    openIncidents: 0,
    summary: summarizeClientHealth(
      statuses.map((currentStatus) => ({
        currentStatus,
        mutedUntil: null,
        isPaused: false,
        isArchived: false,
      })),
      { now: NOW },
    ),
  };
}

describe("chooseFleetView", () => {
  it("shows the 3D view on a capable device when nothing was chosen", () => {
    expect(chooseFleetView("auto", capable)).toEqual({ mode: "3d", canUse3d: true, reason: null });
  });

  it("always shows the 2D view when the system asks for reduced motion, even if 3D was chosen", () => {
    for (const preference of ["auto", "3d", "2d"] as const) {
      const decision = chooseFleetView(preference, { ...capable, reducedMotion: true });
      expect(decision).toMatchObject({ mode: "2d", canUse3d: false });
      expect(decision.reason).toMatch(/reduced motion/);
    }
  });

  it("always shows the 2D view without WebGL 2, even if 3D was chosen", () => {
    for (const preference of ["auto", "3d"] as const) {
      const decision = chooseFleetView(preference, { ...capable, webgl2: false });
      expect(decision).toMatchObject({ mode: "2d", canUse3d: false });
      expect(decision.reason).toMatch(/not available/);
    }
  });

  it("reduced motion is the reason given when both conditions apply", () => {
    const decision = chooseFleetView("3d", { ...capable, reducedMotion: true, webgl2: false });
    expect(decision.reason).toMatch(/reduced motion/);
  });

  it.each([
    ["fewer than four cores", { cores: 2 }],
    ["less than 4 GB of memory", { memoryGb: 2 }],
    ["a request to save data", { saveData: true }],
    ["no graphics acceleration", { softwareRendering: true }],
  ])("defaults to 2D on a device with %s, but leaves 3D available", (_label, override) => {
    expect(chooseFleetView("auto", { ...capable, ...override })).toEqual({
      mode: "2d",
      canUse3d: true,
      reason: null,
    });
  });

  it("lets the person switch 3D on for a low-powered device", () => {
    expect(
      chooseFleetView("3d", {
        ...capable,
        cores: 2,
        memoryGb: 1,
        saveData: true,
        softwareRendering: true,
      }).mode,
    ).toBe("3d");
  });

  it("lets the person switch 3D off on a capable device, without a warning", () => {
    expect(chooseFleetView("2d", capable)).toEqual({ mode: "2d", canUse3d: true, reason: null });
  });

  it("treats exactly four cores or 4 GB as enough, and unreported values as unknown, not low", () => {
    expect(chooseFleetView("auto", { ...capable, cores: 4, memoryGb: 4 }).mode).toBe("3d");
    expect(chooseFleetView("auto", { ...capable, cores: null, memoryGb: null }).mode).toBe("3d");
    expect(chooseFleetView("auto", { ...capable, cores: 3 }).mode).toBe("2d");
  });
});

describe("preference and first render", () => {
  it("reads a stored preference, ignoring anything unexpected", () => {
    expect(parsePreference("3d")).toBe("3d");
    expect(parsePreference("2d")).toBe("2d");
    for (const other of [undefined, null, "", "auto", "4d", "3D", "<script>"]) {
      expect(parsePreference(other)).toBe("auto");
    }
  });

  it("renders 2D first unless this browser has shown 3D before", () => {
    expect(initialFleetView({ preference: undefined, capable: undefined })).toBe("2d");
    expect(initialFleetView({ preference: undefined, capable: "1" })).toBe("3d");
    expect(initialFleetView({ preference: "3d", capable: "1" })).toBe("3d");
    expect(initialFleetView({ preference: "3d", capable: "0" })).toBe("2d");
    expect(initialFleetView({ preference: "3d", capable: undefined })).toBe("2d");
    expect(initialFleetView({ preference: "2d", capable: "1" })).toBe("2d");
    expect(initialFleetView({ preference: "nonsense", capable: "yes" })).toBe("2d");
  });
});

describe("buildConstellation", () => {
  const fleet = [
    client("Worst", ["failed", "missed", "success"]),
    client("Bad", ["failed", "success", "success"]),
    client("Meh", ["warning", "success"]),
    client("Fine", ["success", "success", "running"]),
    client("Empty", []),
  ];

  it("puts the first client at the centre and each later one further out", () => {
    const { nodes } = buildConstellation(fleet);
    const distance = nodes.map((n) => Math.hypot(n.x, n.z));
    expect(distance[0]).toBe(0);
    for (let i = 1; i < distance.length; i += 1) {
      expect(distance[i]!).toBeGreaterThan(distance[i - 1]!);
    }
    expect(nodes.map((n) => n.name)).toEqual(["Worst", "Bad", "Meh", "Fine", "Empty"]);
  });

  it("carries each client's id, health and the same description as the list", () => {
    const [worst, , , fine, empty] = buildConstellation(fleet).nodes;
    expect(worst).toMatchObject({
      id: "id-Worst",
      health: "red",
      description: "1 failed, 1 missed of 3 assets",
    });
    expect(fine).toMatchObject({ health: "green", description: "2 backed up, 1 running" });
    expect(empty).toMatchObject({ health: "none", satellites: [] });
  });

  it("draws one satellite per watched asset, worst first", () => {
    const [worst, , , fine] = buildConstellation(fleet).nodes;
    expect(worst!.satellites).toEqual(["failed", "missed", "success"]);
    expect(fine!.satellites).toEqual(["running", "success", "success"]);
  });

  it("never overlaps two clients, and keeps satellites clear of their neighbours", () => {
    const many = Array.from({ length: 90 }, (_, i) =>
      client(
        `C${i}`,
        Array.from({ length: 1 + (i % 12) }, () => "success" as const),
      ),
    );
    const { nodes } = buildConstellation(many);
    for (let a = 0; a < nodes.length; a += 1) {
      for (let b = a + 1; b < nodes.length; b += 1) {
        const gap = Math.hypot(nodes[a]!.x - nodes[b]!.x, nodes[a]!.z - nodes[b]!.z);
        expect(gap, `${nodes[a]!.name} and ${nodes[b]!.name}`).toBeGreaterThan(
          nodes[a]!.orbit + nodes[b]!.orbit,
        );
      }
    }
  });

  it("grows a client's core with its asset count, within limits", () => {
    const small = buildConstellation([client("S", ["success"])]).nodes[0]!;
    const large = buildConstellation([
      client(
        "L",
        Array.from({ length: 12 }, () => "success" as const),
      ),
    ]).nodes[0]!;
    const huge = buildConstellation([
      client(
        "H",
        Array.from({ length: 400 }, () => "success" as const),
      ),
    ]).nodes[0]!;
    expect(large.radius).toBeGreaterThan(small.radius);
    expect(huge.radius).toBeLessThanOrEqual(0.42);
    expect(small.orbit).toBeGreaterThan(small.radius);
  });

  it("caps the satellites drawn and says how many more there are, keeping the worst", () => {
    const statuses: BackupStatus[] = [
      ...Array.from({ length: 40 }, () => "success" as const),
      "failed",
      "warning",
    ];
    const node = buildConstellation([client("Big", statuses)]).nodes[0]!;
    expect(node.satellites).toHaveLength(MAX_SATELLITES);
    expect(node.moreAssets).toBe(42 - MAX_SATELLITES);
    expect(node.satellites.slice(0, 2)).toEqual(["failed", "warning"]);
  });

  it("caps the clients drawn, keeping the first (worst) ones, and reports the rest", () => {
    const many = Array.from({ length: MAX_NODES + 30 }, (_, i) => client(`C${i}`, ["success"]));
    const built = buildConstellation(many);
    expect(built.nodes).toHaveLength(MAX_NODES);
    expect(built.moreClients).toBe(30);
    expect(built.nodes[0]!.name).toBe("C0");
    expect(built.nodes.at(-1)!.name).toBe(`C${MAX_NODES - 1}`);
  });

  it("frames everything: the extent reaches past the outermost client", () => {
    for (const size of [1, 2, 12, 60, MAX_NODES]) {
      const built = buildConstellation(
        Array.from({ length: size }, (_, i) => client(`C${i}`, ["success"])),
      );
      const outermost = Math.max(...built.nodes.map((n) => Math.hypot(n.x, n.z) + n.orbit));
      expect(built.extent).toBeGreaterThanOrEqual(outermost);
    }
  });

  it("is deterministic and handles an empty fleet", () => {
    expect(buildConstellation(fleet)).toEqual(buildConstellation(fleet));
    expect(buildConstellation([])).toEqual({ nodes: [], moreClients: 0, extent: 1 });
  });
});
