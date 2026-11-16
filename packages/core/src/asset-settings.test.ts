import { describe, expect, it } from "vitest";
import {
  clampAssetHours,
  isMutedIndefinitely,
  MAX_ASSET_HOURS,
  MAX_MUTE_DAYS,
  MUTE_DAY_CHOICES,
  MUTED_INDEFINITELY,
  TECHNICIAN_MAX_MUTE_DAYS,
} from "./asset-settings";
import { isWatched } from "./health";
import { watchSuppression } from "./rules/missed-backup";

describe("muting without an end date", () => {
  it("is recognized, and an ordinary mute is not", () => {
    expect(isMutedIndefinitely(MUTED_INDEFINITELY)).toBe(true);
    expect(isMutedIndefinitely(new Date("2027-01-01T00:00:00Z"))).toBe(false);
    expect(isMutedIndefinitely(null)).toBe(false);
  });

  it("keeps an asset unwatched by every rule, a century from now", () => {
    const later = new Date("2126-01-01T00:00:00Z");
    const asset = { mutedUntil: MUTED_INDEFINITELY, isPaused: false, isArchived: false };
    expect(watchSuppression(asset, later)).toBe("muted");
    expect(isWatched({ ...asset, currentStatus: "failed" }, later)).toBe(false);
  });
});

describe("limits", () => {
  it("offers technicians only mute lengths they are allowed to set", () => {
    expect(MUTE_DAY_CHOICES.some((days) => days <= TECHNICIAN_MAX_MUTE_DAYS)).toBe(true);
    expect(Math.max(...MUTE_DAY_CHOICES)).toBeLessThanOrEqual(MAX_MUTE_DAYS);
  });

  it("makes a vendor-reported frequency safe to store", () => {
    expect(clampAssetHours(24)).toBe(24);
    expect(clampAssetHours(0)).toBe(1);
    expect(clampAssetHours(-5)).toBe(1);
    expect(clampAssetHours(0.4)).toBe(1);
    expect(clampAssetHours(23.6)).toBe(24);
    expect(clampAssetHours(1e9)).toBe(MAX_ASSET_HOURS);
    expect(clampAssetHours(Number.NaN)).toBe(24);
    expect(clampAssetHours(Number.POSITIVE_INFINITY)).toBe(24);
  });
});
