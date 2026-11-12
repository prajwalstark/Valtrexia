import { describe, expect, it } from "vitest";
import { compareWorstFirst, summarizeClientHealth, type HealthAsset } from "./health";
import type { BackupStatus } from "./status";

const NOW = new Date("2026-11-12T12:00:00Z");
const later = new Date("2026-11-13T12:00:00Z");
const earlier = new Date("2026-11-11T12:00:00Z");

function asset(currentStatus: BackupStatus, overrides: Partial<HealthAsset> = {}): HealthAsset {
  return { currentStatus, mutedUntil: null, isPaused: false, isArchived: false, ...overrides };
}

const summarize = (assets: HealthAsset[], syncFailing = false) =>
  summarizeClientHealth(assets, { now: NOW, syncFailing });

describe("summarizeClientHealth", () => {
  it("is green when every watched asset is backing up", () => {
    const summary = summarize([asset("success"), asset("success"), asset("running")]);
    expect(summary).toMatchObject({ health: "green", watched: 3, affected: 0 });
  });

  it("is red when any asset has failed or missed, counting both", () => {
    const summary = summarize([
      asset("success"),
      asset("failed"),
      asset("missed"),
      asset("warning"),
    ]);
    expect(summary.health).toBe("red");
    expect(summary.affected).toBe(2);
    expect(summary.counts).toEqual({
      success: 1,
      warning: 1,
      failed: 1,
      missed: 1,
      running: 0,
      unknown: 0,
    });
  });

  it("is amber for a warning or an uninterpretable status", () => {
    expect(summarize([asset("success"), asset("warning")])).toMatchObject({
      health: "amber",
      affected: 1,
    });
    expect(summarize([asset("success"), asset("unknown")])).toMatchObject({
      health: "amber",
      affected: 1,
    });
  });

  it("is amber when everything looks fine but the vendor sync is failing", () => {
    const summary = summarize([asset("success")], true);
    expect(summary).toMatchObject({ health: "amber", affected: 0 });
  });

  it("stays red, not amber, when the sync is failing and an asset has failed", () => {
    expect(summarize([asset("failed")], true).health).toBe("red");
  });

  it("leaves muted, paused and archived assets out", () => {
    const summary = summarize([
      asset("success"),
      asset("failed", { mutedUntil: later }),
      asset("missed", { isPaused: true }),
      asset("failed", { isArchived: true }),
    ]);
    expect(summary).toMatchObject({ health: "green", watched: 1, excluded: 3, affected: 0 });
  });

  it("counts an asset again once its mute has expired", () => {
    expect(summarize([asset("failed", { mutedUntil: earlier })]).health).toBe("red");
    expect(summarize([asset("failed", { mutedUntil: NOW })]).health).toBe("red");
  });

  it("is none when there is nothing to watch, even if the sync is failing", () => {
    expect(summarize([])).toMatchObject({ health: "none", watched: 0 });
    expect(summarize([asset("failed", { isArchived: true })], true).health).toBe("none");
  });
});

describe("compareWorstFirst", () => {
  const client = (name: string, assets: HealthAsset[], syncFailing = false) => ({
    name,
    summary: summarize(assets, syncFailing),
  });

  it("orders red, then amber, then green, then clients with nothing watched", () => {
    const sorted = [
      client("Green Co", [asset("success")]),
      client("Empty Co", []),
      client("Red Co", [asset("failed")]),
      client("Amber Co", [asset("warning")]),
    ].sort(compareWorstFirst);
    expect(sorted.map((c) => c.name)).toEqual(["Red Co", "Amber Co", "Green Co", "Empty Co"]);
  });

  it("within a level, puts the client with more affected assets first", () => {
    const sorted = [
      client("One failed", [asset("failed"), asset("success")]),
      client("Three failed", [asset("failed"), asset("missed"), asset("failed")]),
      client("Two failed", [asset("failed"), asset("missed")]),
    ].sort(compareWorstFirst);
    expect(sorted.map((c) => c.name)).toEqual(["Three failed", "Two failed", "One failed"]);
  });

  it("breaks ties by name, case-insensitively and with numbers in natural order", () => {
    const sorted = [
      client("Site 10", [asset("success")]),
      client("site 2", [asset("success")]),
      client("Acme", [asset("success")]),
    ].sort(compareWorstFirst);
    expect(sorted.map((c) => c.name)).toEqual(["Acme", "site 2", "Site 10"]);
  });
});
