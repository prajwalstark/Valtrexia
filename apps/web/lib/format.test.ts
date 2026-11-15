import { describe, expect, it } from "vitest";
import { formatDate, timeAgo } from "./format";

const NOW = new Date("2026-11-12T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe("timeAgo", () => {
  it.each([
    [0, "just now"],
    [59_000, "just now"],
    [60_000, "1 minute ago"],
    [5 * 60_000, "5 minutes ago"],
    [59 * 60_000, "59 minutes ago"],
    [60 * 60_000, "1 hour ago"],
    [23 * 3_600_000, "23 hours ago"],
    [24 * 3_600_000, "1 day ago"],
    [13 * 86_400_000, "13 days ago"],
    [14 * 86_400_000, "on 29 Oct 2026"],
  ])("%d ms ago reads as %s", (ms, expected) => {
    expect(timeAgo(ago(ms), NOW)).toBe(expected);
  });

  it("treats a time slightly in the future (clock skew) as just now", () => {
    expect(timeAgo(ago(-5000), NOW)).toBe("just now");
  });
});

describe("formatDate", () => {
  it("formats in UTC regardless of where it runs", () => {
    expect(formatDate(new Date("2026-01-01T00:30:00Z"))).toBe("1 Jan 2026");
    expect(formatDate(new Date("2026-12-31T23:30:00Z"))).toBe("31 Dec 2026");
  });
});
