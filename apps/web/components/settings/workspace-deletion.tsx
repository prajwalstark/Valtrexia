"use client";

import { useActionState, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import type { DeletionState } from "@/lib/workspace-core";

type Action = (previous: DeletionState, formData: FormData) => Promise<DeletionState>;

const IDLE: DeletionState = { status: "idle" };
const dangerButton = "border-status-critical/60 text-status-critical hover:bg-status-critical/10";

/** Asks for the workspace's name before scheduling its deletion. */
export function RequestDeletionForm({
  workspaceName,
  holdDays,
  action,
}: {
  workspaceName: string;
  holdDays: number;
  action: Action;
}) {
  const [state, submit, pending] = useActionState(action, IDLE);
  const [typed, setTyped] = useState("");
  const id = useId();
  const fieldError = state.status === "error" ? state.fieldError : undefined;

  return (
    <form action={submit} className="max-w-md" noValidate>
      <p className="text-sm leading-relaxed text-muted-foreground">
        Syncing and notifications stop at once. After {holdDays} days, every client, asset, backup
        result, incident, saved key, notification channel and audit entry in this workspace is
        deleted for good. Until then you can cancel. Your organization and its members are not
        affected.
      </p>
      <Label htmlFor={id} className="mt-5 block">
        Type <span className="font-semibold">{workspaceName}</span> to confirm
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
        className={`mt-4 ${dangerButton}`}
        disabled={pending || typed.trim() !== workspaceName}
      >
        {pending ? "Scheduling…" : "Delete this workspace"}
      </Button>
      {state.status === "error" && !fieldError ? (
        <Notice kind="error" className="mt-4">
          {state.message}
        </Notice>
      ) : null}
    </form>
  );
}

/** Cancels a pending deletion. */
export function CancelDeletionForm({ action }: { action: Action }) {
  const [state, submit, pending] = useActionState(action, IDLE);
  return (
    <form action={submit}>
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Cancelling…" : "Cancel the deletion"}
      </Button>
      {state.status === "error" ? (
        <Notice kind="error" className="mt-4">
          {state.message}
        </Notice>
      ) : null}
    </form>
  );
}
