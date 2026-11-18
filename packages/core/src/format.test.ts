import { describe, expect, it } from "vitest";
import {
  dayKey,
  formatDate,
  formatDateTime,
  isTimeZone,
  lastDayKeys,
  listTimeZones,
  timeAgo,
  timeZoneLabel,
} from "./format";

const NOW = new Date("2026-11-12T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const NEW_YORK = "America/New_York";
const SYDNEY = "Australia/Sydney";

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
    expect(timeAgo(ago(ms), NOW, "UTC")).toBe(expected);
  });

  it("treats a time slightly in the future (clock skew) as just now", () => {
    expect(timeAgo(ago(-5000), NOW, "UTC")).toBe("just now");
  });

  it("names an older date on the workspace's calendar", () => {
    // 02:00 UTC on 29 October is still the evening of the 28th in New York.
    const date = new Date("2026-10-29T02:00:00Z");
    expect(timeAgo(date, NOW, "UTC")).toBe("on 29 Oct 2026");
    expect(timeAgo(date, NOW, NEW_YORK)).toBe("on 28 Oct 2026");
  });
});

describe("formatDate and formatDateTime", () => {
  it("formats in UTC when that is the workspace's zone, wherever the server runs", () => {
    expect(formatDate(new Date("2026-01-01T00:30:00Z"), "UTC")).toBe("1 Jan 2026");
    expect(formatDate(new Date("2026-12-31T23:30:00Z"), "UTC")).toBe("31 Dec 2026");
    expect(formatDateTime(new Date("2026-11-12T13:05:00Z"), "UTC")).toBe("12 Nov, 13:05 UTC");
  });

  it("puts a moment on the workspace's own day and clock", () => {
    const moment = new Date("2026-11-12T03:30:00Z");
    expect(formatDate(moment, NEW_YORK)).toBe("11 Nov 2026");
    expect(formatDateTime(moment, NEW_YORK)).toBe("11 Nov, 22:30 GMT-5");
    expect(formatDate(moment, SYDNEY)).toBe("12 Nov 2026");
    expect(formatDateTime(moment, SYDNEY)).toBe("12 Nov, 14:30 GMT+11");
    expect(formatDateTime(moment, "Asia/Kolkata")).toBe("12 Nov, 09:00 GMT+5:30");
  });

  it("crosses the year boundary with the zone", () => {
    const moment = new Date("2027-01-01T02:00:00Z");
    expect(formatDate(moment, "UTC")).toBe("1 Jan 2027");
    expect(formatDate(moment, NEW_YORK)).toBe("31 Dec 2026");
  });

  it("labels the zone as it is at that moment, summer or winter", () => {
    const winter = new Date("2026-01-15T12:00:00Z");
    const summer = new Date("2026-07-15T12:00:00Z");
    expect(timeZoneLabel("Europe/London", winter)).toBe("GMT");
    expect(timeZoneLabel("Europe/London", summer)).toBe("BST");
    expect(formatDateTime(winter, NEW_YORK)).toBe("15 Jan, 07:00 GMT-5");
    expect(formatDateTime(summer, NEW_YORK)).toBe("15 Jul, 08:00 GMT-4");
    expect(timeZoneLabel("UTC", summer)).toBe("UTC");
  });

  it("uses a 24-hour clock, with midnight as 00:00", () => {
    expect(formatDateTime(new Date("2026-11-12T05:00:00Z"), NEW_YORK)).toBe("12 Nov, 00:00 GMT-5");
    expect(formatDateTime(new Date("2026-11-12T22:15:00Z"), NEW_YORK)).toBe("12 Nov, 17:15 GMT-5");
  });
});

describe("dayKey", () => {
  it("is the calendar day in the zone, as YYYY-MM-DD", () => {
    const moment = new Date("2026-11-12T03:30:00Z");
    expect(dayKey(moment, "UTC")).toBe("2026-11-12");
    expect(dayKey(moment, NEW_YORK)).toBe("2026-11-11");
    expect(dayKey(moment, "Pacific/Kiritimati")).toBe("2026-11-12");
    expect(dayKey(new Date("2026-11-12T11:00:00Z"), "Pacific/Kiritimati")).toBe("2026-11-13");
  });

  it("changes exactly at local midnight", () => {
    // Midnight in New York in November is 05:00 UTC.
    expect(dayKey(new Date("2026-11-12T04:59:59.999Z"), NEW_YORK)).toBe("2026-11-11");
    expect(dayKey(new Date("2026-11-12T05:00:00.000Z"), NEW_YORK)).toBe("2026-11-12");
    // And in July, with daylight saving, it is 04:00 UTC.
    expect(dayKey(new Date("2026-07-12T03:59:59.999Z"), NEW_YORK)).toBe("2026-07-11");
    expect(dayKey(new Date("2026-07-12T04:00:00.000Z"), NEW_YORK)).toBe("2026-07-12");
  });

  it("pads single-digit months and days", () => {
    expect(dayKey(new Date("2026-03-05T12:00:00Z"), "UTC")).toBe("2026-03-05");
  });
});

describe("lastDayKeys", () => {
  it("lists the last days oldest first, ending on the zone's today", () => {
    // 03:30 UTC on the 12th: already the 12th in UTC, still the 11th in New York.
    const now = new Date("2026-11-12T03:30:00Z");
    expect(lastDayKeys(now, 3, "UTC")).toEqual(["2026-11-10", "2026-11-11", "2026-11-12"]);
    expect(lastDayKeys(now, 3, NEW_YORK)).toEqual(["2026-11-09", "2026-11-10", "2026-11-11"]);
  });

  it("counts calendar days across the autumn clock change, when one day is 25 hours long", () => {
    // New York's clocks go back on 1 November 2026.
    const now = new Date("2026-11-03T12:00:00Z");
    expect(lastDayKeys(now, 5, NEW_YORK)).toEqual([
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
      "2026-11-03",
    ]);
  });

  it("counts calendar days across the spring clock change, when one day is 23 hours long", () => {
    // New York's clocks go forward on 8 March 2026.
    const now = new Date("2026-03-10T03:30:00Z"); // 9 March, 23:30 local
    expect(lastDayKeys(now, 4, NEW_YORK)).toEqual([
      "2026-03-06",
      "2026-03-07",
      "2026-03-08",
      "2026-03-09",
    ]);
  });

  it("never repeats or skips a day, in any zone, across a whole year", () => {
    for (const zone of ["UTC", NEW_YORK, SYDNEY, "Europe/London", "Pacific/Kiritimati"]) {
      for (let day = 0; day < 366; day += 1) {
        const now = new Date(Date.UTC(2026, 0, 1, 12) + day * 86_400_000);
        const keys = lastDayKeys(now, 14, zone);
        expect(keys).toHaveLength(14);
        expect(keys.at(-1)).toBe(dayKey(now, zone));
        for (let i = 1; i < keys.length; i += 1) {
          const step = Date.parse(`${keys[i]}T00:00:00Z`) - Date.parse(`${keys[i - 1]}T00:00:00Z`);
          expect(step).toBe(86_400_000);
        }
      }
    }
  });

  it("crosses months and years", () => {
    expect(lastDayKeys(new Date("2027-01-01T12:00:00Z"), 3, "UTC")).toEqual([
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
    ]);
    expect(lastDayKeys(new Date("2028-03-01T12:00:00Z"), 2, "UTC")).toEqual([
      "2028-02-29",
      "2028-03-01",
    ]);
  });
});

describe("time zones a workspace can choose", () => {
  it("lists UTC first, then the IANA zones, without repeats", () => {
    const zones = listTimeZones();
    expect(zones[0]).toBe("UTC");
    expect(zones.length).toBeGreaterThan(300);
    expect(new Set(zones).size).toBe(zones.length);
    expect(zones).toContain("America/New_York");
    expect(zones).toContain("Europe/London");
  });

  it("accepts every listed zone, and current IANA names the list spells another way", () => {
    for (const zone of listTimeZones()) expect(isTimeZone(zone)).toBe(true);
    expect(isTimeZone("Asia/Kolkata")).toBe(true);
    expect(isTimeZone("America/Argentina/Buenos_Aires")).toBe(true);
  });

  it.each([
    "",
    "Mars/Olympus_Mons",
    "EST",
    "utc",
    "america/new_york",
    "GMT+5",
    "+05:00",
    "America/New_York; DROP TABLE tenants",
    " UTC",
    42,
    null,
    undefined,
  ])("refuses %j", (value) => {
    expect(isTimeZone(value)).toBe(false);
  });
});
