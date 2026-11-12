import { CircleAlert, CircleCheck, CircleDashed, RefreshCw } from "lucide-react";
import { timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface SyncState {
  syncStatus: "never" | "running" | "ok" | "error";
  lastSyncAt: Date | null;
  lastSyncError: string | null;
}

/** An integration's sync state as an icon and a sentence. */
export function SyncStatus({
  state,
  now,
  className,
}: {
  state: SyncState;
  now: Date;
  className?: string;
}) {
  const last = state.lastSyncAt ? `Last synced ${timeAgo(state.lastSyncAt, now)}` : null;

  const view = {
    never: { icon: CircleDashed, tone: "text-status-unknown", text: "Waiting for its first sync" },
    running: {
      icon: RefreshCw,
      tone: "text-status-running",
      text: last ? `Syncing now. ${last}` : "Syncing now",
    },
    ok: { icon: CircleCheck, tone: "text-status-success", text: last ?? "Synced" },
    error: {
      icon: CircleAlert,
      tone: "text-status-critical",
      text: `Sync failing. ${state.lastSyncError ?? "The last sync did not complete."}${last ? ` ${last}.` : ""}`,
    },
  }[state.syncStatus];
  const Icon = view.icon;

  return (
    <p className={cn("flex items-start gap-2 text-sm text-muted-foreground", className)}>
      <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", view.tone)} />
      <span>{view.text}</span>
    </p>
  );
}
