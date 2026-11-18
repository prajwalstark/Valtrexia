import type { BackupStatus, Health } from "@valtrexia/core";
import {
  ClockAlert,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  CircleSlash,
  CircleX,
  LoaderCircle,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * How each status looks everywhere it appears: one icon, one word, one
 * colour. The colour is carried by the icon; the word is always in the
 * normal text colour, so nothing depends on telling red from green.
 */
export const STATUS_META: Record<
  BackupStatus,
  { label: string; icon: LucideIcon; tone: string; fill: string }
> = {
  failed: {
    label: "Failed",
    icon: CircleX,
    tone: "text-status-critical",
    fill: "var(--status-critical)",
  },
  missed: {
    label: "Missed",
    icon: CircleSlash,
    tone: "text-status-critical",
    fill: "var(--status-critical)",
  },
  warning: {
    label: "Warning",
    icon: TriangleAlert,
    tone: "text-status-warning",
    fill: "var(--status-warning)",
  },
  unknown: {
    label: "Unknown",
    icon: CircleHelp,
    tone: "text-status-unknown",
    fill: "var(--status-unknown)",
  },
  running: {
    label: "Running",
    icon: LoaderCircle,
    tone: "text-status-running",
    fill: "var(--status-running)",
  },
  success: {
    label: "Success",
    icon: CircleCheck,
    tone: "text-status-success",
    fill: "var(--status-success)",
  },
};

/** How each kind of incident is named and drawn, wherever incidents are listed. */
export const INCIDENT_META: Record<
  "failed" | "missed" | "stale",
  { label: string; icon: LucideIcon; tone: string }
> = {
  failed: { label: "Backup failed", icon: CircleX, tone: "text-status-critical" },
  missed: { label: "Backup missed", icon: CircleSlash, tone: "text-status-critical" },
  stale: { label: "SLA breached", icon: ClockAlert, tone: "text-status-critical" },
};

export const HEALTH_META: Record<
  Health,
  { label: string; icon: LucideIcon; tone: string; fill: string }
> = {
  red: {
    label: "Action needed",
    icon: CircleX,
    tone: "text-status-critical",
    fill: "var(--status-critical)",
  },
  amber: {
    label: "Review",
    icon: TriangleAlert,
    tone: "text-status-warning",
    fill: "var(--status-warning)",
  },
  green: {
    label: "Healthy",
    icon: CircleCheck,
    tone: "text-status-success",
    fill: "var(--status-success)",
  },
  none: {
    label: "Nothing watched",
    icon: CircleDashed,
    tone: "text-status-unknown",
    fill: "var(--status-unknown)",
  },
};

function Badge({
  meta,
  className,
}: {
  meta: { label: string; icon: LucideIcon; tone: string };
  className?: string;
}) {
  const Icon = meta.icon;
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm whitespace-nowrap", className)}>
      <Icon aria-hidden="true" className={cn("size-4 shrink-0", meta.tone)} />
      {meta.label}
    </span>
  );
}

export function StatusBadge({ status, className }: { status: BackupStatus; className?: string }) {
  return <Badge meta={STATUS_META[status]} {...(className ? { className } : {})} />;
}

export function HealthBadge({ health, className }: { health: Health; className?: string }) {
  return <Badge meta={HEALTH_META[health]} {...(className ? { className } : {})} />;
}
