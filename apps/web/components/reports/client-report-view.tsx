import { brand, type AssetMonth } from "@valtrexia/core";
import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { DayGlyph } from "@/components/clients/day-strip";
import { INCIDENT_META, STATUS_META } from "@/components/status/status";
import { Notice } from "@/components/ui/notice";
import {
  count,
  formatDate,
  formatDayKey,
  formatHours,
  formatMonth,
  formatShare,
} from "@/lib/format";
import { cellStatus, type ClientReportPage, type ReportCell } from "@/lib/report-core";
import { cn } from "@/lib/utils";
import { PrintButton } from "./print-button";

const CELL = 11;

/**
 * A client's month on one page, written to be handed to the client: on
 * screen, printed, or saved as a PDF from the print dialog.
 */
export function ClientReportView({ page, now }: { page: ClientReportPage; now: Date }) {
  const { client, report, timeZone } = page;
  const monthName = formatMonth(page.month);
  const base = `/clients/${client.id}/report`;
  const zone = timeZone === "UTC" ? "UTC" : timeZone.replaceAll("_", " ");
  const opened = Object.values(report.incidents.opened).reduce((a, b) => a + b, 0);
  const closed = Object.values(report.incidents.closed).reduce((a, b) => a + b, 0);

  return (
    <article className="max-w-6xl">
      <Link
        href={`/clients/${client.id}`}
        className="inline-flex items-center gap-1 rounded-md text-sm text-muted-foreground hover:text-foreground print:hidden"
      >
        <ChevronLeft aria-hidden="true" className="size-4" />
        {client.name}
      </Link>

      <header className="mt-4 flex flex-wrap items-end justify-between gap-x-8 gap-y-4 border-b border-line pb-6 print:mt-0">
        <div>
          <p className="text-xs font-semibold tracking-[0.14em] text-iris uppercase">
            Monthly backup report
          </p>
          <h1 className="mt-2 font-wide text-2xl font-semibold tracking-[-0.02em] text-balance">
            {client.name}
          </h1>
          <p className="mt-1.5 text-muted-foreground">
            {monthName}
            <span className="text-subtle-foreground"> · days in {zone} time</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 print:hidden">
          <nav aria-label="Other months" className="flex items-center gap-1">
            <MonthLink
              href={page.previous && `${base}?month=${page.previous}`}
              direction="previous"
            >
              {page.previous ? formatMonth(page.previous) : null}
            </MonthLink>
            <MonthLink href={page.next && `${base}?month=${page.next}`} direction="next">
              {page.next ? formatMonth(page.next) : null}
            </MonthLink>
          </nav>
          <PrintButton />
        </div>
      </header>

      {report.partial ? (
        <Notice kind="info" className="mt-6">
          {monthName} is still in progress. These figures run to today and will change.
        </Notice>
      ) : null}

      {report.summary.assets === 0 ? (
        <p className="mt-8 border-l-2 border-iris-dim pl-4 text-muted-foreground">
          None of this client’s assets were being watched in {monthName}.
        </p>
      ) : (
        <>
          <dl className="mt-8 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line lg:grid-cols-4 print:grid-cols-4">
            <Figure
              label="On schedule"
              value={formatShare(report.summary.onSchedule!)}
              note={`of days, across ${count(report.summary.assets, "asset")}`}
            />
            <Figure
              label="Within SLA"
              value={formatShare(report.summary.withinSla!)}
              note="of days, across the same assets"
            />
            <Figure
              label="Backups completed"
              value={String(report.summary.backups.completed)}
              note={
                report.summary.backups.failed === 0
                  ? "none failed"
                  : `${count(report.summary.backups.failed, "failed backup")} as well`
              }
            />
            <Figure
              label="Incidents"
              value={String(opened)}
              note={
                closed === 0
                  ? "opened, none resolved"
                  : `opened, ${closed} resolved` +
                    (report.incidents.medianHoursToClose === null
                      ? ""
                      : `, typically in ${formatHours(report.incidents.medianHoursToClose)}`)
              }
            />
          </dl>

          <section className="mt-10" aria-labelledby="assets-heading">
            <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
              <div className="max-w-2xl">
                <h2 id="assets-heading" className="text-lg font-semibold">
                  Assets
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Least reliable first. Each square is one day: the day’s worst backup, or a missed
                  backup when one was due and none had completed.
                </p>
              </div>
              <ReportLegend />
            </div>
            <div className="mt-5 overflow-x-auto print:overflow-visible">
              <table className="w-full min-w-[48rem] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-line-strong text-left text-xs text-subtle-foreground">
                    <th scope="col" className="py-2 pr-4 font-medium">
                      Asset
                    </th>
                    <th scope="col" className="py-2 pr-4 font-medium">
                      <DayNumbers days={report.days} />
                    </th>
                    <Numeric>On schedule</Numeric>
                    <Numeric>Within SLA</Numeric>
                    <Numeric>Completed</Numeric>
                    <Numeric>Failed</Numeric>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {report.assets.map((asset) => (
                    <tr key={asset.id} className="break-inside-avoid">
                      <th scope="row" className="py-2.5 pr-4 text-left font-normal">
                        <span className="block font-medium">{asset.name}</span>
                        {asset.deviceName ? (
                          <span className="block text-xs text-subtle-foreground">
                            {asset.deviceName}
                          </span>
                        ) : null}
                      </th>
                      <td className="py-2.5 pr-4">
                        <MonthStrip asset={asset} days={report.days} monthName={monthName} />
                      </td>
                      <NumericCell
                        strong={asset.onSchedule < 1}
                        value={formatShare(asset.onSchedule)}
                      />
                      <NumericCell
                        strong={asset.withinSla < 1}
                        value={formatShare(asset.withinSla)}
                      />
                      <NumericCell value={String(asset.backups.completed)} />
                      <NumericCell
                        strong={asset.backups.failed > 0}
                        value={String(asset.backups.failed)}
                      />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="mt-10 grid gap-8 break-inside-avoid md:grid-cols-2 print:grid-cols-2">
            <div>
              <h2 className="text-lg font-semibold">Incidents</h2>
              <table className="mt-3 w-full max-w-md border-collapse text-sm">
                <thead>
                  <tr className="border-b border-line-strong text-left text-xs text-subtle-foreground">
                    <th scope="col" className="py-2 pr-4 font-medium">
                      Type
                    </th>
                    <Numeric>Opened</Numeric>
                    <Numeric>Resolved</Numeric>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {(["failed", "missed", "stale"] as const).map((type) => (
                    <tr key={type}>
                      <th scope="row" className="py-2 pr-4 text-left font-normal">
                        {INCIDENT_META[type].label}
                      </th>
                      <NumericCell value={String(report.incidents.opened[type])} />
                      <NumericCell value={String(report.incidents.closed[type])} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="text-sm leading-relaxed text-muted-foreground">
              <h2 className="text-lg font-semibold text-foreground">How this is measured</h2>
              <p className="mt-3">
                Each asset is checked at the end of every day. It is <em>on schedule</em> if its
                last completed backup is no older than its expected interval plus a grace period,
                and <em>within SLA</em> if it is no older than the agreed recovery point. A weekly
                backup is judged by its weekly schedule.
              </p>
              <p className="mt-2">
                A backup that completed with warnings counts as completed. Days before an asset was
                first seen are not counted.
              </p>
            </div>
          </section>
        </>
      )}

      {report.excluded.length > 0 ? (
        <p className="mt-8 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Not included:</span>{" "}
          {report.excluded.map((asset) => `${asset.name} (${EXCLUSION[asset.reason]})`).join(", ")}.
          Their figures are left out while they are not being watched.
        </p>
      ) : null}

      <footer className="mt-12 border-t border-line pt-4 text-xs text-subtle-foreground">
        Prepared {formatDate(now, timeZone)} with {brand.name}.
      </footer>
    </article>
  );
}

const EXCLUSION = { paused: "paused", archived: "archived", muted: "muted" } as const;

function Figure({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="bg-background px-5 py-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="mt-1 font-wide text-3xl font-semibold tracking-[-0.02em] tabular-nums">
        {value}
      </dd>
      <dd className="mt-1 text-xs text-subtle-foreground">{note}</dd>
    </div>
  );
}

function Numeric({ children }: { children: string }) {
  return (
    <th scope="col" className="py-2 pl-4 text-right font-medium whitespace-nowrap">
      {children}
    </th>
  );
}

function NumericCell({ value, strong = false }: { value: string; strong?: boolean }) {
  return (
    <td
      className={cn(
        "py-2.5 pl-4 text-right tabular-nums",
        strong ? "font-semibold text-foreground" : "text-muted-foreground",
      )}
    >
      {value}
    </td>
  );
}

function MonthLink({
  href,
  direction,
  children,
}: {
  href: string | null;
  direction: "previous" | "next";
  children: string | null;
}) {
  const Icon = direction === "previous" ? ChevronLeft : ChevronRight;
  const className =
    "inline-flex h-8 items-center gap-1 rounded-md px-2 text-sm text-muted-foreground";
  if (!href || !children) {
    return (
      <span className={cn(className, "opacity-40")} aria-hidden="true">
        <Icon className="size-4" />
      </span>
    );
  }
  return (
    <Link href={href} className={cn(className, "hover:bg-surface-raised hover:text-foreground")}>
      {direction === "previous" ? <Icon aria-hidden="true" className="size-4" /> : null}
      {children}
      {direction === "next" ? <Icon aria-hidden="true" className="size-4" /> : null}
    </Link>
  );
}

/** Day numbers over the strips, one a week, so a reader can find a date. */
function DayNumbers({ days }: { days: string[] }) {
  return (
    <span className="flex gap-px" aria-label="Days of the month">
      {days.map((day) => {
        const number = Number(day.slice(8));
        return (
          <span key={day} className="relative" style={{ width: CELL }}>
            {(number - 1) % 7 === 0 ? (
              <span className="absolute left-0 -translate-y-1/2 tabular-nums">{number}</span>
            ) : null}
          </span>
        );
      })}
    </span>
  );
}

function describeCell(date: string, status: ReportCell): string {
  if (status === null) return `${formatDayKey(date)}: no backup due`;
  if (status === "overdue") return `${formatDayKey(date)}: no backup, one was due`;
  return `${formatDayKey(date)}: ${STATUS_META[status].label.toLowerCase()}`;
}

/**
 * A report cell: the dashboard's glyph for a result, and for a day an asset
 * was overdue, an outlined square with a cross, so it reads apart from a
 * failure in black and white as well as in colour.
 */
function CellGlyph({ status }: { status: ReportCell }) {
  if (status !== "overdue") return <DayGlyph status={status} size={CELL} />;
  return (
    <svg width={CELL} height={CELL} viewBox="0 0 14 14" aria-hidden="true">
      <rect
        x="1.5"
        y="1.5"
        width="11"
        height="11"
        rx="3"
        fill="none"
        stroke="var(--status-critical)"
        strokeWidth="1.5"
      />
      <path
        d="M5 5l4 4M9 5l-4 4"
        stroke="var(--status-critical)"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MonthStrip({
  asset,
  days,
  monthName,
}: {
  asset: AssetMonth;
  days: string[];
  monthName: string;
}) {
  const byDate = new Map(asset.days.map((day) => [day.date, day]));
  const behind = asset.days.filter((day) => !day.onSchedule).length;
  const failed = asset.days.filter((day) => day.worst === "failed").length;
  const label =
    `${asset.name}, ${monthName}: on schedule ${asset.days.length - behind} of ${count(asset.days.length, "day")}` +
    (failed > 0 ? `, a failed backup on ${count(failed, "day")}` : "");

  return (
    <div role="img" aria-label={label} className="flex gap-px">
      {days.map((date) => {
        const day = byDate.get(date);
        if (!day) return <span key={date} style={{ width: CELL, height: CELL }} />;
        const status = cellStatus(day);
        return (
          <span key={date} className="group/day relative -my-1 py-1">
            <CellGlyph status={status} />
            <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-0.5 hidden -translate-x-1/2 rounded-md border border-line-strong bg-surface-raised px-2 py-1 text-xs whitespace-nowrap text-foreground group-hover/day:block print:hidden">
              {describeCell(date, status)}
            </span>
          </span>
        );
      })}
    </div>
  );
}

const LEGEND: [ReportCell, string][] = [
  ["success", "Completed"],
  ["warning", "Completed with warnings"],
  ["failed", "Failed"],
  ["overdue", "Missed: none completed, one was due"],
  [null, "None due"],
];

function ReportLegend() {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
      {LEGEND.map(([status, label]) => (
        <li key={label} className="inline-flex items-center gap-1.5">
          <CellGlyph status={status} />
          {label}
        </li>
      ))}
    </ul>
  );
}
