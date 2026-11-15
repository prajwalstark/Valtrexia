import { summarizeClientHealth, type BackupStatus, type HealthAsset } from "@valtrexia/core";
import { describe, expect, it } from "vitest";
import { describeClient } from "./describe";
import { count, formatDateTime, formatDayKey } from "./format";

const NOW = new Date("2026-11-12T12:00:00Z");
const asset = (currentStatus: BackupStatus, extra: Partial<HealthAsset> = {}): HealthAsset => ({
  currentStatus,
  mutedUntil: null,
  isPaused: false,
  isArchived: false,
  ...extra,
});
const say = (assets: HealthAsset[], syncFailing = false) =>
  describeClient(summarizeClientHealth(assets, { now: NOW, syncFailing }));

describe("describeClient", () => {
  it("names what has failed or been missed, and out of how many", () => {
    expect(
      say([asset("failed"), asset("failed"), asset("missed"), asset("success"), asset("warning")]),
    ).toBe("2 failed, 1 missed of 5 assets");
    expect(say([asset("missed")])).toBe("1 missed of 1 asset");
  });

  it("names warnings and unreadable statuses when nothing is worse", () => {
    expect(say([asset("warning"), asset("unknown"), asset("success")])).toBe(
      "1 with warnings, 1 unknown of 3 assets",
    );
  });

  it("says the sync is failing when that is the only problem", () => {
    expect(say([asset("success"), asset("success")], true)).toBe(
      "Vendor sync failing; 2 assets not confirmed",
    );
  });

  it("confirms a healthy client, mentioning backups in progress", () => {
    expect(say([asset("success"), asset("success"), asset("success")])).toBe(
      "All 3 assets backed up",
    );
    expect(say([asset("success")])).toBe("Its 1 asset is backed up");
    expect(say([asset("success"), asset("success"), asset("running")])).toBe(
      "2 backed up, 1 running",
    );
  });

  it("explains a client with nothing to watch", () => {
    expect(say([])).toBe("No protected assets found yet");
    expect(say([asset("failed", { isArchived: true }), asset("success", { isPaused: true })])).toBe(
      "2 assets, none being watched",
    );
  });
});

describe("formatting", () => {
  it("formats a date and time in UTC on a 24-hour clock", () => {
    expect(formatDateTime(new Date("2026-11-12T13:05:00Z"))).toBe("12 Nov, 13:05 UTC");
    expect(formatDateTime(new Date("2026-01-01T00:00:00Z"))).toBe("1 Jan, 00:00 UTC");
    expect(formatDateTime(new Date("2026-11-12T23:59:00-05:00"))).toBe("13 Nov, 04:59 UTC");
  });

  it("formats a day key", () => {
    expect(formatDayKey("2026-11-02")).toBe("2 Nov");
  });

  it("pluralizes", () => {
    expect(count(0, "asset")).toBe("0 assets");
    expect(count(1, "asset")).toBe("1 asset");
    expect(count(2, "asset")).toBe("2 assets");
    expect(count(2, "entry", "entries")).toBe("2 entries");
  });
});
