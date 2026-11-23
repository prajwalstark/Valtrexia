const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Dates are stored in UTC and shown in the workspace's time zone. Every
 * function here that prints a calendar date or a clock time takes the zone,
 * and there is no default: a caller cannot show a date without deciding whose
 * day it is.
 *
 * The zone is always passed explicitly to `Intl`, never taken from the
 * machine, so the server and the browser render the same text.
 */
export const DEFAULT_TIME_ZONE = "UTC";

let zones: readonly string[] | undefined;

/** Every time zone a workspace can choose: UTC first, then the IANA names, in order. */
export function listTimeZones(): readonly string[] {
  zones ??= [
    DEFAULT_TIME_ZONE,
    ...Intl.supportedValuesOf("timeZone").filter((zone) => zone !== DEFAULT_TIME_ZONE),
  ];
  return zones;
}

/**
 * Whether a value is a time zone a workspace can use: one from the list, or
 * another IANA name this runtime can format, written the way IANA writes
 * them ("Area/Location", each part capitalized).
 *
 * The list alone is too narrow, because it holds one spelling per zone and
 * not always the current one ("Asia/Calcutta", not "Asia/Kolkata"). Asking
 * `Intl` alone is too wide: it also accepts abbreviations and any letter
 * case, which would then be stored as typed.
 */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (listTimeZones().includes(value)) return true;
  if (!/^[A-Z][A-Za-z_]+(\/[A-Z][A-Za-z0-9_+-]*)+$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(
  timeZone: string,
  name: string,
  options: Intl.DateTimeFormatOptions,
  locale = "en-GB",
): Intl.DateTimeFormat {
  const key = `${timeZone}|${name}`;
  let found = formatters.get(key);
  if (!found) {
    found = new Intl.DateTimeFormat(locale, { ...options, timeZone });
    formatters.set(key, found);
  }
  return found;
}

/**
 * The calendar day a moment falls on in a time zone, as YYYY-MM-DD. Two
 * moments are "the same day" for a workspace exactly when their keys match.
 */
export function dayKey(date: Date, timeZone: string): string {
  // en-CA writes dates as YYYY-MM-DD.
  return formatter(
    timeZone,
    "key",
    { year: "numeric", month: "2-digit", day: "2-digit" },
    "en-CA",
  ).format(date);
}

/**
 * The keys of the last `days` calendar days in a time zone, oldest first,
 * ending with the day `now` falls on.
 *
 * Counted on the calendar, not in 24-hour steps: a day that is 23 or 25
 * hours long because the clocks changed is still one day.
 */
export function lastDayKeys(now: Date, days: number, timeZone: string): string[] {
  const [year, month, day] = dayKey(now, timeZone).split("-").map(Number) as [
    number,
    number,
    number,
  ];
  return Array.from({ length: days }, (_, index) => {
    // Date.UTC normalizes a day of 0 or below into the previous month.
    const stepped = new Date(Date.UTC(year, month - 1, day - (days - 1) + index));
    return stepped.toISOString().slice(0, 10);
  });
}

/**
 * The first moment of a calendar day (YYYY-MM-DD) in a time zone: local
 * midnight, as an instant. Where the clocks skip midnight, the first moment
 * that exists that day.
 */
export function startOfDay(key: string, timeZone: string): Date {
  const [year, month, day] = key.split("-").map(Number) as [number, number, number];
  const wall = Date.UTC(year, month - 1, day);
  // The zone's offset near that moment, applied twice so a change of offset
  // on that very day is accounted for.
  let instant = wall - offsetAt(wall, timeZone);
  instant = wall - offsetAt(instant, timeZone);
  // If midnight did not exist, the result lands on the previous day; step to
  // the first hour that does.
  while (dayKey(new Date(instant), timeZone) < key) instant += HOUR;
  return new Date(instant);
}

/** The zone's offset from UTC at an instant, in milliseconds. */
function offsetAt(instant: number, timeZone: string): number {
  const parts = formatter(
    timeZone,
    "offset",
    {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    },
    "en-CA",
  ).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** The calendar days of a month (YYYY-MM), as day keys, first to last. */
export function daysOfMonth(month: string): string[] {
  const [year, number] = month.split("-").map(Number) as [number, number];
  const length = new Date(Date.UTC(year, number, 0)).getUTCDate();
  return Array.from({ length }, (_, index) => `${month}-${String(index + 1).padStart(2, "0")}`);
}

/** A month written as YYYY-MM, from 2000 to 2999. */
export function isMonthKey(value: string): boolean {
  return /^2\d{3}-(0[1-9]|1[0-2])$/.test(value);
}

/** The month (YYYY-MM) a moment falls in, in a time zone. */
export function monthKey(date: Date, timeZone: string): string {
  return dayKey(date, timeZone).slice(0, 7);
}

/** The month before or after a month: shiftMonth("2026-01", -1) is "2025-12". */
export function shiftMonth(month: string, by: number): string {
  const [year, number] = month.split("-").map(Number) as [number, number];
  const shifted = new Date(Date.UTC(year, number - 1 + by, 1));
  return shifted.toISOString().slice(0, 7);
}

/** "October 2026". */
export function formatMonth(month: string): string {
  const [year, number] = month.split("-").map(Number) as [number, number];
  return new Intl.DateTimeFormat("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, number - 1, 1)));
}

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago", then a date. */
export function timeAgo(date: Date, now: Date, timeZone: string): string {
  const elapsed = now.getTime() - date.getTime();
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return plural(Math.floor(elapsed / MINUTE), "minute");
  if (elapsed < DAY) return plural(Math.floor(elapsed / HOUR), "hour");
  if (elapsed < 14 * DAY) return plural(Math.floor(elapsed / DAY), "day");
  return `on ${formatDate(date, timeZone)}`;
}

/** How long ago, as a length of time: "a moment", "5 minutes", "3 hours", "2 days". */
export function elapsed(date: Date, now: Date = new Date()): string {
  const ms = now.getTime() - date.getTime();
  if (ms < MINUTE) return "a moment";
  if (ms < HOUR) return count(Math.floor(ms / MINUTE), "minute");
  if (ms < DAY) return count(Math.floor(ms / HOUR), "hour");
  return count(Math.floor(ms / DAY), "day");
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}

/** "12 Nov 2026", on the workspace's calendar. */
export function formatDate(date: Date, timeZone: string): string {
  return formatter(timeZone, "date", { day: "numeric", month: "short", year: "numeric" }).format(
    date,
  );
}

/**
 * The short name of a time zone at a moment: "UTC", "GMT", "BST", "CET",
 * "GMT-5". It depends on the moment because of daylight saving.
 */
export function timeZoneLabel(timeZone: string, at: Date): string {
  if (timeZone === DEFAULT_TIME_ZONE) return "UTC";
  const parts = formatter(timeZone, "zone", { timeZoneName: "short" }).formatToParts(at);
  return parts.find((part) => part.type === "timeZoneName")?.value ?? timeZone;
}

/** "12 Nov, 13:05 UTC", or "12 Nov, 08:05 GMT-5" for a workspace in New York. */
export function formatDateTime(date: Date, timeZone: string): string {
  const day = formatter(timeZone, "day", { day: "numeric", month: "short" }).format(date);
  const time = formatter(timeZone, "time", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
  return `${day}, ${time} ${timeZoneLabel(timeZone, date)}`;
}

/** "12 Nov" from a YYYY-MM-DD day key. The key already names a calendar day; no zone is involved. */
export function formatDayKey(key: string): string {
  return formatter("UTC", "day", { day: "numeric", month: "short" }).format(
    new Date(`${key}T00:00:00Z`),
  );
}

/** "1 asset", "3 assets". */
export function count(n: number, singular: string, plural: string = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * A share as a percentage to one decimal place: "96.8%", "100%", "0%".
 * Rounded down, so anything short of all of it never reads as 100%.
 */
export function formatShare(share: number): string {
  const tenths = Math.floor(share * 1000 + 1e-9);
  return `${tenths % 10 === 0 ? tenths / 10 : (tenths / 10).toFixed(1)}%`;
}

/** A length of time given in hours: "under an hour", "4 hours", "2.5 days". */
export function formatHours(hours: number): string {
  if (hours < 1) return "under an hour";
  if (hours < 48) return count(Math.round(hours), "hour");
  const days = Math.round((hours / 24) * 10) / 10;
  return `${days} days`;
}
