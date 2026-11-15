import type { BackupStatus } from "@valtrexia/core";
import { STATUS_META } from "@/components/status/status";
import type { AssetDay } from "@/lib/dashboard-core";
import { count, formatDayKey } from "@/lib/format";

const SIZE = 14;
const INK = "var(--background)";

/**
 * One day's cell. Every status has its own shape as well as its own colour,
 * so the strip reads without colour vision:
 *
 *   success  solid square        failed   solid, with a cross
 *   warning  solid, with a dot   running  ring only
 *   unknown  solid, with a slash none     faint outline (no backup that day)
 */
export function DayGlyph({ status }: { status: BackupStatus | null }) {
  const common = { width: SIZE, height: SIZE, viewBox: "0 0 14 14", "aria-hidden": true } as const;

  if (status === null) {
    return (
      <svg {...common}>
        <rect x="1" y="1" width="12" height="12" rx="3" fill="none" stroke="var(--line-strong)" />
      </svg>
    );
  }
  const fill = STATUS_META[status].fill;
  if (status === "running") {
    return (
      <svg {...common}>
        <rect
          x="1.5"
          y="1.5"
          width="11"
          height="11"
          rx="3"
          fill="none"
          stroke={fill}
          strokeWidth="2"
        />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <rect width="14" height="14" rx="3" fill={fill} />
      {status === "failed" || status === "missed" ? (
        <path d="M4.5 4.5l5 5M9.5 4.5l-5 5" stroke={INK} strokeWidth="1.75" strokeLinecap="round" />
      ) : null}
      {status === "warning" ? <circle cx="7" cy="7" r="1.75" fill={INK} /> : null}
      {status === "unknown" ? (
        <path d="M4.5 9.5l5-5" stroke={INK} strokeWidth="1.75" strokeLinecap="round" />
      ) : null}
    </svg>
  );
}

function describeDay(day: AssetDay): string {
  if (day.worst === null) return `${formatDayKey(day.date)}: no backup`;
  const worst = STATUS_META[day.worst].label.toLowerCase();
  return day.count === 1
    ? `${formatDayKey(day.date)}: 1 backup, ${worst}`
    : `${formatDayKey(day.date)}: ${count(day.count, "backup")}, worst ${worst}`;
}

/**
 * An asset's last 14 days, one cell per UTC day, oldest on the left. Each
 * cell shows the day's worst result; an empty cell is a day with no backup.
 *
 * Hovering a cell names the day and what happened. That is a convenience:
 * the same information is in the results listed under each asset, which is
 * also what keyboard and screen-reader users get.
 */
export function DayStrip({ days, assetName }: { days: AssetDay[]; assetName: string }) {
  const withBackup = days.filter((day) => day.count > 0).length;
  const bad = days.filter((d) => d.worst === "failed" || d.worst === "missed").length;
  const label =
    `${assetName}, last ${days.length} days: backups on ${withBackup}` +
    (bad > 0 ? `, ${count(bad, "day")} with a failure` : "");

  return (
    <div role="img" aria-label={label} className="flex gap-0.5">
      {days.map((day) => (
        <span key={day.date} className="group/day relative -my-1.5 py-1.5">
          <DayGlyph status={day.worst} />
          <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-0.5 hidden -translate-x-1/2 rounded-md border border-line-strong bg-surface-raised px-2 py-1 text-xs whitespace-nowrap text-foreground group-hover/day:block">
            {describeDay(day)}
          </span>
        </span>
      ))}
    </div>
  );
}

const LEGEND: [BackupStatus | null, string][] = [
  ["success", "Success"],
  ["warning", "Warning"],
  ["failed", "Failed"],
  ["running", "Running"],
  ["unknown", "Unknown"],
  [null, "No backup that day"],
];

export function DayStripLegend() {
  return (
    <ul className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm text-muted-foreground">
      {LEGEND.map(([status, label]) => (
        <li key={label} className="inline-flex items-center gap-1.5">
          <DayGlyph status={status} />
          {label}
        </li>
      ))}
    </ul>
  );
}
