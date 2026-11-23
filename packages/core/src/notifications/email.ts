import { brand } from "../brand";
import { count, formatDateTime, formatMonth, formatShare } from "../format";
import type { RaisedIncidentType } from "../rules/incidents";
import type {
  IncidentPayloadEntry,
  MonthlyReportClient,
  MonthlyReportPayload,
  NotificationPayload,
} from "./plan";

/**
 * A notification as an email: a subject, a plain-text body and an HTML body
 * saying the same thing. Written from the message stored in the outbox, so an
 * email says exactly what a webhook for the same change would.
 *
 * Every value that came from a vendor or a person (client and asset names,
 * the workspace name, error messages) is escaped before it goes into HTML.
 */

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const PROBLEM: Record<RaisedIncidentType, string> = {
  failed: "Backup failed",
  missed: "Backup missed",
  stale: "Past its SLA",
};
const RESOLVED: Record<RaisedIncidentType, string> = {
  failed: "Failed backup resolved",
  missed: "Missed backup resolved",
  stale: "Back within its SLA",
};

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Subjects are one line: a name containing a line break must not add headers. */
function oneLine(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").trim();
}

function byClient(entries: readonly IncidentPayloadEntry[]): [string, IncidentPayloadEntry[]][] {
  const groups = new Map<string, IncidentPayloadEntry[]>();
  for (const entry of entries) {
    const list = groups.get(entry.client.name) ?? [];
    list.push(entry);
    groups.set(entry.client.name, list);
  }
  return [...groups];
}

interface Section {
  heading: string;
  /** A heading per group (a client), its lines, and optionally a link for the heading. */
  groups: [string, string[], (string | undefined)?][];
}

function layout(input: {
  subject: string;
  intro: string;
  sections: Section[];
  /** A closing paragraph after the sections. */
  outro?: string;
  timeZone: string;
  channelName: string;
}): RenderedEmail {
  const zone = input.timeZone === "UTC" ? "UTC" : input.timeZone.replaceAll("_", " ");
  const footer = `Times are in ${zone}. You receive this because you are listed on the "${input.channelName}" notification channel in ${brand.name}.`;

  const text = [
    input.intro,
    ...input.sections.flatMap((section) => [
      "",
      section.heading.toUpperCase(),
      ...section.groups.flatMap(([client, lines, href]) => [
        "",
        client,
        ...lines.map((line) => `  - ${line}`),
        ...(href ? [`  ${href}`] : []),
      ]),
    ]),
    ...(input.outro ? ["", input.outro] : []),
    "",
    "--",
    footer,
  ].join("\n");

  const html = [
    '<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1d2433;line-height:1.5;max-width:640px">',
    `<p>${escapeHtml(input.intro)}</p>`,
    ...input.sections.map(
      (section) =>
        `<h2 style="font-size:16px;margin:24px 0 8px">${escapeHtml(section.heading)}</h2>` +
        section.groups
          .map(
            ([client, lines, href]) =>
              `<p style="margin:12px 0 4px;font-weight:600">${
                href
                  ? `<a href="${escapeHtml(href)}" style="color:#4b3fbf">${escapeHtml(client)}</a>`
                  : escapeHtml(client)
              }</p><ul style="margin:0;padding-left:20px">${lines
                .map((line) => `<li>${escapeHtml(line)}</li>`)
                .join("")}</ul>`,
          )
          .join(""),
    ),
    ...(input.outro ? [`<p style="margin-top:24px">${escapeHtml(input.outro)}</p>`] : []),
    `<p style="margin-top:32px;color:#5b6475;font-size:13px">${escapeHtml(footer)}</p>`,
    "</body></html>",
  ].join("");

  return { subject: oneLine(input.subject), text, html };
}

/** Most clients listed by name in a monthly summary email. */
export const MAX_EMAIL_REPORT_CLIENTS = 25;

/**
 * @param timeZone The workspace's time zone, for every date in the email.
 * @param channelName Named in the footer, so a recipient knows why they got it.
 * @param appBaseUrl Where the app is served, for links; without it, there are none.
 */
export function renderNotificationEmail(
  payload: NotificationPayload,
  options: { timeZone: string; channelName: string; appBaseUrl?: string },
): RenderedEmail {
  const { timeZone, channelName } = options;
  const when = (iso: string | null) => (iso ? formatDateTime(new Date(iso), timeZone) : null);
  const workspace = payload.data.workspace.name;

  switch (payload.type) {
    case "incidents.changed": {
      const { opened, closed } = payload.data;
      const clients = new Set([...opened, ...closed].map((entry) => entry.client.name));
      const where = clients.size === 1 ? ` at ${[...clients][0]!}` : "";
      const parts: string[] = [];
      if (opened.length > 0) parts.push(count(opened.length, "new backup problem"));
      if (closed.length > 0) {
        parts.push(
          opened.length > 0
            ? `${closed.length} resolved`
            : count(closed.length, "backup problem") + " resolved",
        );
      }
      const openedLine = (entry: IncidentPayloadEntry) => {
        const last = when(entry.lastBackupAt);
        return `${entry.asset.name}: ${PROBLEM[entry.type]}. ${last ? `Last good backup ${last}.` : "No good backup on record."}`;
      };
      const closedLine = (entry: IncidentPayloadEntry) =>
        `${entry.asset.name}: ${RESOLVED[entry.type]}${entry.closedAt ? ` at ${when(entry.closedAt)!}` : ""}.`;
      const sections: Section[] = [];
      if (opened.length > 0) {
        sections.push({
          heading: "Needs attention",
          groups: byClient(opened).map(([client, entries]) => [client, entries.map(openedLine)]),
        });
      }
      if (closed.length > 0) {
        sections.push({
          heading: "Resolved",
          groups: byClient(closed).map(([client, entries]) => [client, entries.map(closedLine)]),
        });
      }
      return layout({
        subject: `${brand.name}: ${parts.join(", ")}${where}`,
        intro: `${parts.join(", ")[0]!.toUpperCase()}${parts.join(", ").slice(1)} in ${workspace}${where}.`,
        sections,
        timeZone,
        channelName,
      });
    }
    case "integration.unhealthy": {
      const { integration, failingSince, error, needsAction } = payload.data;
      const since = when(failingSince);
      const lines = [
        `${integration.name} has been failing to sync${since ? ` since ${since}` : ""}.`,
        ...(error ? [`The last attempt said: ${error}`] : []),
        needsAction
          ? "It will keep failing until its connection details are replaced in the integration's settings."
          : "Syncs are retried every few minutes. Backup statuses for its clients are not being updated until it recovers.",
      ];
      return layout({
        subject: `${brand.name}: ${integration.name} is failing to sync`,
        intro: `An integration in ${workspace} needs attention.`,
        sections: [{ heading: "Integration failing", groups: [[integration.name, lines]] }],
        timeZone,
        channelName,
      });
    }
    case "integration.recovered": {
      const { integration, failingSince } = payload.data;
      const since = when(failingSince);
      return layout({
        subject: `${brand.name}: ${integration.name} is syncing again`,
        intro: `${integration.name} in ${workspace} is syncing again${since ? `, after failing since ${since}` : ""}.`,
        sections: [],
        timeZone,
        channelName,
      });
    }
    case "report.monthly":
      return renderMonthlyReport(payload, { ...options, workspace });
    case "test":
      return layout({
        subject: `${brand.name}: test notification`,
        intro: `${payload.data.message} It was sent from ${workspace} at ${when(payload.timestamp)!}.`,
        sections: [],
        timeZone,
        channelName,
      });
  }
}

function renderMonthlyReport(
  payload: MonthlyReportPayload,
  options: { timeZone: string; channelName: string; appBaseUrl?: string; workspace: string },
): RenderedEmail {
  const { month, clients, totals } = payload.data;
  const monthName = formatMonth(month);
  const base = options.appBaseUrl?.replace(/\/+$/, "");
  const link = (path: string) => (base ? `${base}${path}` : undefined);

  if (totals.clients === 0) {
    return layout({
      subject: `${brand.name}: backup summary for ${monthName}`,
      intro: `No client assets were being watched in ${options.workspace} in ${monthName}.`,
      sections: [],
      timeZone: options.timeZone,
      channelName: options.channelName,
    });
  }

  const needsLook = (client: MonthlyReportClient) =>
    client.onSchedule < 1 || client.withinSla < 1 || client.backups.failed > 0;
  const attention = clients.filter(needsLook);
  const listed = attention.slice(0, MAX_EMAIL_REPORT_CLIENTS);
  const unlisted = attention.length - listed.length + payload.data.omittedClients;
  const fine = totals.clients - attention.length - payload.data.omittedClients;

  const line = (client: MonthlyReportClient) => {
    const parts = [
      `On schedule ${formatShare(client.onSchedule)} of days, within SLA ${formatShare(client.withinSla)}`,
      client.backups.failed > 0 ? count(client.backups.failed, "failed backup") : null,
      client.incidentsOpened > 0 ? count(client.incidentsOpened, "incident") : null,
    ].filter(Boolean);
    return `${parts.join("; ")}. ${count(client.assets, "asset")}.`;
  };

  const outro = [
    unlisted > 0 ? `${count(unlisted, "more client")} also had problems.` : null,
    fine > 0
      ? fine === totals.clients
        ? "Every client was on schedule every day, with no failed backups."
        : `${count(fine, "other client")} ${fine === 1 ? "was" : "were"} on schedule every day, with no failed backups.`
      : null,
    base ? `Each client's full report: ${link("/dashboard")}` : null,
  ]
    .filter(Boolean)
    .join(" ");

  return layout({
    subject: `${brand.name}: backup summary for ${monthName}`,
    intro:
      `In ${monthName}, ${options.workspace}'s ${count(totals.clients, "client")} ` +
      `(${count(totals.assets, "asset")}) were on schedule ${formatShare(totals.onSchedule!)} of days ` +
      `and within SLA ${formatShare(totals.withinSla!)}. ` +
      `${count(totals.backups.completed, "backup")} completed and ${totals.backups.failed} failed; ` +
      `${count(totals.incidentsOpened, "incident")} ${totals.incidentsOpened === 1 ? "was" : "were"} opened.`,
    sections:
      listed.length > 0
        ? [
            {
              heading: "Least reliable",
              groups: listed.map((client) => [
                client.name,
                [line(client)],
                link(`/clients/${encodeURIComponent(client.id)}/report?month=${month}`),
              ]),
            },
          ]
        : [],
    ...(outro ? { outro } : {}),
    timeZone: options.timeZone,
    channelName: options.channelName,
  });
}
