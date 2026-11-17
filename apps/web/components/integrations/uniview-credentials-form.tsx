"use client";

import Link from "next/link";
import { useActionState, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import type { ActionState } from "@/lib/integrations-core";

type FormAction = (previous: ActionState, formData: FormData) => Promise<ActionState>;

const IDLE: ActionState = { status: "idle" };

/**
 * The Kaseya UniView form: an API client's ID and secret. Used to connect a
 * new integration and to replace an existing one's details. Like the other
 * vendor forms, its inputs are controlled, so a test does not clear them, and
 * nothing the server sends back contains the secret.
 */
export function UniviewCredentialsForm({
  mode,
  saveAction,
  testAction,
  cancelHref,
}: {
  mode: "connect" | "replace";
  saveAction: FormAction;
  testAction: FormAction;
  cancelHref: string;
}) {
  const [saveState, save, saving] = useActionState(saveAction, IDLE);
  const [testState, test, testing] = useActionState(testAction, IDLE);
  const [name, setName] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const ids = { name: useId(), clientId: useId(), clientSecret: useId() };
  // Show the result of whichever button was used last; see the Datto form.
  const [lastAction, setLastAction] = useState<"save" | "test">("save");
  const state = lastAction === "save" ? saveState : testState;
  const errors = state.status === "error" ? (state.fieldErrors ?? {}) : {};
  const busy = saving || testing;

  return (
    <form action={save} className="max-w-md" noValidate>
      {mode === "connect" ? (
        <div>
          <Label htmlFor={ids.name}>Label (optional)</Label>
          <Input
            id={ids.name}
            name="name"
            className="mt-2"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={60}
            placeholder="Kaseya UniView (Unitrends)"
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={`${ids.name}-help`}
          />
          <p id={`${ids.name}-help`} className="mt-1.5 text-sm text-subtle-foreground">
            {errors.name ?? "Useful if you connect more than one UniView account."}
          </p>
        </div>
      ) : null}

      <div className={mode === "connect" ? "mt-6" : undefined}>
        <Label htmlFor={ids.clientId}>Client ID</Label>
        <Input
          id={ids.clientId}
          name="clientId"
          className="mt-2"
          value={clientId}
          onChange={(event) => setClientId(event.target.value)}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          required
          aria-invalid={errors.clientId ? true : undefined}
          aria-describedby={`${ids.clientId}-help`}
        />
        <p
          id={`${ids.clientId}-help`}
          className={
            errors.clientId
              ? "mt-1.5 text-sm text-destructive"
              : "mt-1.5 text-sm text-subtle-foreground"
          }
        >
          {errors.clientId ??
            "In the UniView Portal, open API Access and add an API client. Its client ID and secret are shown there."}
        </p>
      </div>

      <div className="mt-6">
        <Label htmlFor={ids.clientSecret}>Client secret</Label>
        <Input
          id={ids.clientSecret}
          name="clientSecret"
          type="password"
          className="mt-2"
          value={clientSecret}
          onChange={(event) => setClientSecret(event.target.value)}
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          spellCheck={false}
          required
          aria-invalid={errors.clientSecret ? true : undefined}
          aria-describedby={`${ids.clientSecret}-help`}
        />
        <p
          id={`${ids.clientSecret}-help`}
          className={
            errors.clientSecret
              ? "mt-1.5 text-sm text-destructive"
              : "mt-1.5 text-sm text-subtle-foreground"
          }
        >
          {errors.clientSecret ??
            "Encrypted before it is stored; it cannot be viewed again, only replaced."}
        </p>
      </div>

      <div className="mt-8 flex flex-wrap gap-3">
        <Button type="submit" disabled={busy} onClick={() => setLastAction("save")}>
          {saving
            ? "Checking with UniView…"
            : mode === "connect"
              ? "Save and connect"
              : "Replace connection details"}
        </Button>
        <Button
          type="submit"
          variant="outline"
          formAction={test}
          disabled={busy}
          onClick={() => setLastAction("test")}
        >
          {testing ? "Testing…" : "Test connection"}
        </Button>
        <Button asChild variant="ghost">
          <Link href={cancelHref}>Cancel</Link>
        </Button>
      </div>

      <div className="mt-6" aria-live="polite">
        {state.status === "ok" ? <Notice kind="ok">{state.message}</Notice> : null}
        {state.status === "error" ? <Notice kind="error">{state.message}</Notice> : null}
      </div>
    </form>
  );
}
