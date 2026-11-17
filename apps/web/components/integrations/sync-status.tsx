import { CircleAlert, CircleCheck, CircleDashed, RefreshCw, TriangleAlert } from "lucide-react";
import { describeSync, type SyncFacts } from "@/lib/describe";
import { cn } from "@/lib/utils";

const LOOK = {
  waiting: { icon: CircleDashed, tone: "text-status-unknown" },
  healthy: { icon: CircleCheck, tone: "text-status-success" },
  retrying: { icon: TriangleAlert, tone: "text-status-warning" },
  unhealthy: { icon: CircleAlert, tone: "text-status-critical" },
  stalled: { icon: CircleAlert, tone: "text-status-critical" },
} as const;

/** An integration's sync state as an icon and a sentence. */
export function SyncStatus({
  state,
  now,
  syncIntervalMinutes,
  timeZone,
  className,
}: {
  state: SyncFacts;
  now: Date;
  syncIntervalMinutes: number;
  timeZone: string;
  className?: string;
}) {
  const description = describeSync(state, now, syncIntervalMinutes, timeZone);
  const look = description.syncing
    ? { icon: RefreshCw, tone: "text-status-running" }
    : LOOK[description.state];
  const Icon = look.icon;

  return (
    <p className={cn("flex items-start gap-2 text-sm text-muted-foreground", className)}>
      <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", look.tone)} />
      <span>{description.text}</span>
    </p>
  );
}
