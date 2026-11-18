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
