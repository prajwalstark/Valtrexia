"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import type { ChannelState } from "@/lib/notifications-core";
import { cn } from "@/lib/utils";

type Action = () => Promise<ChannelState>;

/** Send a test, switch the channel on or off, or delete it. Owners only. */
export function ChannelControls({
  name,
  enabled,
  testAction,
  enableAction,
  disableAction,
  deleteAction,
}: {
  name: string;
  enabled: boolean;
  testAction: Action;
  enableAction: Action;
  disableAction: Action;
  deleteAction: Action;
}) {
  const [state, setState] = useState<ChannelState>({ status: "idle" });
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();
  const run = (action: Action) =>
    startTransition(async () => {
      setState(await action());
      setConfirming(false);
    });

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending || !enabled}
          onClick={() => run(testAction)}
        >
          Send a test
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => run(enabled ? disableAction : enableAction)}
        >
          {enabled ? "Turn off" : "Turn on"}
        </Button>
        {confirming ? (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              className="border-status-critical/60 text-status-critical hover:bg-status-critical/10"
              onClick={() => run(deleteAction)}
            >
              Delete {name}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              Keep it
            </Button>
          </>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => setConfirming(true)}
          >
            Delete
          </Button>
        )}
      </div>
      {state.status === "idle" ? null : (
        <p
          role={state.status === "error" ? "alert" : "status"}
          className={cn(
            "mt-2 text-sm",
            state.status === "error" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {state.message}
        </p>
      )}
    </div>
  );
}
