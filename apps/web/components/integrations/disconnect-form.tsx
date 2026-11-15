"use client";

import { useActionState, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import type { ActionState } from "@/lib/integrations-core";

/** Disconnecting deletes backup history, so it asks for the name to be typed. */
export function DisconnectForm({
  integrationName,
  action,
}: {
  integrationName: string;
  action: (previous: ActionState, formData: FormData) => Promise<ActionState>;
}) {
  const [state, submit, pending] = useActionState(action, { status: "idle" });
  const [typed, setTyped] = useState("");
  const id = useId();
  const fieldError = state.status === "error" ? state.fieldErrors?.confirm : undefined;

  return (
    <form action={submit} className="max-w-md" noValidate>
      <Label htmlFor={id}>
        Type <span className="font-semibold">{integrationName}</span> to confirm
      </Label>
      <Input
        id={id}
        name="confirm"
        className="mt-2"
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={fieldError ? true : undefined}
        aria-describedby={fieldError ? `${id}-error` : undefined}
      />
      {fieldError ? (
        <p id={`${id}-error`} className="mt-1.5 text-sm text-destructive">
          {fieldError}
        </p>
      ) : null}
      <Button
        type="submit"
        variant="outline"
        className="mt-4 border-status-critical/60 text-status-critical hover:bg-status-critical/10"
        disabled={pending || typed.trim() !== integrationName}
      >
        {pending ? "Disconnecting…" : "Disconnect and remove data"}
      </Button>
      {state.status === "error" && !fieldError ? (
        <Notice kind="error" className="mt-4">
          {state.message}
        </Notice>
      ) : null}
    </form>
  );
}
