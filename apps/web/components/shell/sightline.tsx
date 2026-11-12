import { SYNC_INTERVAL_MINUTES } from "@valtrexia/core";
import { CircleDashed } from "lucide-react";

/**
 * The strip across the top of every page that keeps fleet health in view.
 * Until a vendor is connected there is nothing to count, so it says so.
 * Step 10 fills it with live failed, missed and warning counts.
 */
export function Sightline() {
  return (
    <div
      role="status"
      aria-label="Fleet status"
      className="flex min-h-12 flex-wrap items-center justify-between gap-x-6 gap-y-1 border-b border-line bg-surface px-4 py-2 text-sm md:px-8"
    >
      <p className="flex items-center gap-2 text-muted-foreground">
        <CircleDashed aria-hidden="true" className="size-4 text-status-unknown" />
        Nothing in sight yet. Connect a vendor to start watching backups.
      </p>
      <p className="text-subtle-foreground">
        Backups are checked every {SYNC_INTERVAL_MINUTES} minutes
      </p>
    </div>
  );
}
