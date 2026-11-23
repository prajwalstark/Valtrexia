"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import type { ChannelState } from "@/lib/notifications-core";
import { useFormAction } from "@/lib/use-form-action";
import { Check, FieldError, TYPES, type FormAction } from "./form-parts";

/**
 * Connects Syncro. The token is checked against Syncro before anything is
 * saved, then stored encrypted; the field is never filled back in.
 */
export function SyncroForm({ action, onDone }: { action: FormAction; onDone: () => void }) {
  const [state, submit, pending] = useFormAction<ChannelState>(action, { status: "idle" });
  const id = useId();
  const [name, setName] = useState("Syncro tickets");
  const [subdomain, setSubdomain] = useState("");
  const [types, setTypes] = useState<string[]>(["failed", "missed", "stale"]);
  const errors = state.status === "error" ? state.fieldErrors : undefined;

  if (state.status === "ok") {
    return (
      <div className="max-w-xl">
        <Notice kind="ok">{state.message}</Notice>
        <div className="mt-4 flex flex-wrap gap-3">
          {state.channelId ? (
            <Button asChild size="sm">
              <Link href={`/notifications/${state.channelId}`}>Match clients</Link>
            </Button>
          ) : null}
          <Button type="button" variant="outline" size="sm" onClick={onDone}>
            Add another channel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="max-w-xl">
      <p className="text-sm leading-relaxed text-muted-foreground">
        Opens a ticket in Syncro for each asset with a backup problem, adds later problems to the
        same ticket, and resolves it when the asset recovers. Comments are internal: hidden from
        your customers and never emailed to them.
      </p>
      <div className="mt-5">
        <Label htmlFor={`${id}-name`}>Name</Label>
        <Input
          id={`${id}-name`}
          name="name"
          className="mt-2"
          maxLength={80}
          value={name}
          onChange={(event) => setName(event.target.value)}
          aria-invalid={errors?.name ? true : undefined}
          aria-describedby={errors?.name ? `${id}-name-error` : undefined}
        />
        <FieldError id={`${id}-name-error`} message={errors?.name} />
      </div>
      <div className="mt-5">
        <Label htmlFor={`${id}-subdomain`}>Syncro subdomain</Label>
        <div className="mt-2 flex items-center gap-2">
          <Input
            id={`${id}-subdomain`}
            name="subdomain"
            value={subdomain}
            onChange={(event) => setSubdomain(event.target.value)}
            placeholder="yourmsp"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={errors?.subdomain ? true : undefined}
            aria-describedby={`${id}-subdomain-help${errors?.subdomain ? ` ${id}-subdomain-error` : ""}`}
          />
          <span className="shrink-0 text-sm text-muted-foreground">.syncromsp.com</span>
        </div>
        <FieldError id={`${id}-subdomain-error`} message={errors?.subdomain} />
        <p id={`${id}-subdomain-help`} className="mt-2 text-sm text-muted-foreground">
          The name in your Syncro address. Pasting the whole address works too.
        </p>
      </div>
      <div className="mt-5">
        <Label htmlFor={`${id}-token`}>API token</Label>
        <Input
          id={`${id}-token`}
          name="apiToken"
          type="password"
          className="mt-2 font-mono"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={errors?.apiToken ? true : undefined}
          aria-describedby={`${id}-token-help${errors?.apiToken ? ` ${id}-token-error` : ""}`}
        />
        <FieldError id={`${id}-token-error`} message={errors?.apiToken} />
        <p id={`${id}-token-help`} className="mt-2 text-sm text-muted-foreground">
          Create one in Syncro under your user profile, ideally for a user kept for this. It needs
          to list customers, and to list, create, view and edit tickets. It is checked with Syncro,
          stored encrypted, and never shown again.
        </p>
      </div>
      <fieldset
        className="mt-6"
        aria-describedby={errors?.incidentTypes ? `${id}-types-error` : undefined}
      >
        <legend className="text-sm font-medium">Open tickets for</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {TYPES.map((type) => (
            <Check
              key={type.value}
              name="incidentTypes"
              value={type.value}
              label={type.label}
              checked={types.includes(type.value)}
              onChange={(checked) =>
                setTypes((previous) =>
                  checked ? [...previous, type.value] : previous.filter((t) => t !== type.value),
                )
              }
            />
          ))}
        </div>
        <FieldError id={`${id}-types-error`} message={errors?.incidentTypes} />
      </fieldset>
      <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Checking with Syncro…" : "Connect Syncro"}
        </Button>
        {state.status === "error" && !state.fieldErrors ? (
          <p role="alert" className="text-sm text-destructive">
            {state.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}
