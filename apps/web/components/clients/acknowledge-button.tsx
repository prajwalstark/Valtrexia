"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import type { ActionState } from "@/lib/integrations-core";

/** Marks an open incident as seen. The page reloads its data when it succeeds. */
export function AcknowledgeButton({ action }: { action: () => Promise<ActionState> }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <span className="inline-flex items-center gap-3">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const state = await action();
            setError(state.status === "error" ? state.message : null);
          })
        }
      >
        {pending ? "Saving…" : "Acknowledge"}
      </Button>
      {error ? (
        <span role="alert" className="text-sm text-destructive">
          {error}
        </span>
      ) : null}
    </span>
  );
}
