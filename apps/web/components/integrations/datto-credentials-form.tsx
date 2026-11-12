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
 * The Datto key pair form, used both to connect a new integration and to
 * replace an existing one's keys.
 *
 * The inputs are controlled so that testing the connection does not clear
 * what was typed. The keys only ever travel from here to the server: nothing
 * the server sends back contains them, and a saved integration's keys are
 * never loaded into this form.
 */
export function DattoCredentialsForm({
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
  const [publicKey, setPublicKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const ids = { name: useId(), publicKey: useId(), secretKey: useId(), result: useId() };

  // Show the result of whichever button was used last. This is tracked on the
  // buttons, not on the form's submit event, which fires for both of them.
  // Pressing Enter in a field clicks the first submit button, so it counts
  // as "save".
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
            placeholder="Datto BCDR"
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={`${ids.name}-help`}
          />
          <p id={`${ids.name}-help`} className="mt-1.5 text-sm text-subtle-foreground">
            {errors.name ?? "Useful if you connect more than one Datto partner account."}
          </p>
        </div>
      ) : null}

      <div className={mode === "connect" ? "mt-6" : undefined}>
        <Label htmlFor={ids.publicKey}>API public key</Label>
        <Input
          id={ids.publicKey}
          name="publicKey"
          className="mt-2"
          value={publicKey}
          onChange={(event) => setPublicKey(event.target.value)}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          required
          aria-invalid={errors.publicKey ? true : undefined}
          aria-describedby={errors.publicKey ? `${ids.publicKey}-error` : undefined}
        />
        {errors.publicKey ? (
          <p id={`${ids.publicKey}-error`} className="mt-1.5 text-sm text-destructive">
            {errors.publicKey}
          </p>
        ) : null}
      </div>

      <div className="mt-6">
        <Label htmlFor={ids.secretKey}>API secret key</Label>
        <Input
          id={ids.secretKey}
          name="secretKey"
          type="password"
          className="mt-2"
          value={secretKey}
          onChange={(event) => setSecretKey(event.target.value)}
          // Not a login: keep password managers from offering to save or fill it.
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          spellCheck={false}
          required
          aria-invalid={errors.secretKey ? true : undefined}
          aria-describedby={`${ids.secretKey}-help`}
        />
        <p
          id={`${ids.secretKey}-help`}
          className={
            errors.secretKey
              ? "mt-1.5 text-sm text-destructive"
              : "mt-1.5 text-sm text-subtle-foreground"
          }
        >
          {errors.secretKey ??
            "Encrypted before it is stored. After saving it cannot be viewed again, only replaced."}
        </p>
      </div>

      <div className="mt-8 flex flex-wrap gap-3">
        <Button type="submit" disabled={busy} onClick={() => setLastAction("save")}>
          {saving
            ? "Checking with Datto…"
            : mode === "connect"
              ? "Save and connect"
              : "Replace keys"}
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

      <div id={ids.result} className="mt-6" aria-live="polite">
        {state.status === "ok" ? <Notice kind="ok">{state.message}</Notice> : null}
        {state.status === "error" ? <Notice kind="error">{state.message}</Notice> : null}
      </div>
    </form>
  );
}
