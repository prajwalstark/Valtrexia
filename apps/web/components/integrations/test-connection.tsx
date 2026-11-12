"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import type { ActionState } from "@/lib/integrations-core";

/**
 * Tests a saved integration's keys. The browser sends only the request to
 * test; the keys are decrypted and used on the server and never come back.
 */
export function TestConnection({ action }: { action: () => Promise<ActionState> }) {
  const [state, setState] = useState<ActionState>({ status: "idle" });
  const [pending, startTransition] = useTransition();

  return (
    <div>
      <Button
        type="button"
        variant="outline"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setState(await action());
          })
        }
      >
        {pending ? "Testing…" : "Test connection"}
      </Button>
      <div className="mt-4 max-w-md" aria-live="polite">
        {state.status === "ok" ? <Notice kind="ok">{state.message}</Notice> : null}
        {state.status === "error" ? <Notice kind="error">{state.message}</Notice> : null}
      </div>
    </div>
  );
}
