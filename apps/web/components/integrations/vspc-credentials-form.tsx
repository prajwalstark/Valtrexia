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
 * The Veeam Service Provider Console form: the console's address and an API
 * key. Used to connect a new integration and to replace an existing one's
 * details. Like the Datto form, its inputs are controlled, so a test does not
 * clear them, and nothing the server sends back contains the key.
 */
export function VspcCredentialsForm({
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
  const [serverUrl, setServerUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const ids = { name: useId(), serverUrl: useId(), apiKey: useId() };
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
            placeholder="Veeam Service Provider Console"
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={`${ids.name}-help`}
          />
          <p id={`${ids.name}-help`} className="mt-1.5 text-sm text-subtle-foreground">
            {errors.name ?? "Useful if you connect more than one console."}
          </p>
        </div>
      ) : null}

      <div className={mode === "connect" ? "mt-6" : undefined}>
        <Label htmlFor={ids.serverUrl}>Console address</Label>
        <Input
          id={ids.serverUrl}
          name="serverUrl"
          type="url"
          inputMode="url"
          className="mt-2"
          value={serverUrl}
          onChange={(event) => setServerUrl(event.target.value)}
          placeholder="https://vspc.yourmsp.com:1280"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          required
          aria-invalid={errors.serverUrl ? true : undefined}
          aria-describedby={`${ids.serverUrl}-help`}
        />
        <p
          id={`${ids.serverUrl}-help`}
          className={
            errors.serverUrl
              ? "mt-1.5 text-sm text-destructive"
              : "mt-1.5 text-sm text-subtle-foreground"
          }
        >
          {errors.serverUrl ??
            "The address of the console's REST API, which listens on port 1280 by default. It must be reachable from the internet over https, with a valid certificate."}
        </p>
      </div>

      <div className="mt-6">
        <Label htmlFor={ids.apiKey}>API key</Label>
        <Input
          id={ids.apiKey}
          name="apiKey"
          type="password"
          className="mt-2"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          spellCheck={false}
          required
          aria-invalid={errors.apiKey ? true : undefined}
          aria-describedby={`${ids.apiKey}-help`}
        />
        <p
          id={`${ids.apiKey}-help`}
          className={
            errors.apiKey
              ? "mt-1.5 text-sm text-destructive"
              : "mt-1.5 text-sm text-subtle-foreground"
          }
        >
          {errors.apiKey ??
            "Create one in VSPC for a portal administrator or operator, with the REST API scope and read-only access. Encrypted before it is stored; it cannot be viewed again, only replaced."}
        </p>
      </div>

      <div className="mt-8 flex flex-wrap gap-3">
        <Button type="submit" disabled={busy} onClick={() => setLastAction("save")}>
          {saving
            ? "Checking with the console…"
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
