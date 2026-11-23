"use client";

import { MAX_EMAIL_RECIPIENTS_CLIENT } from "./limits";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import type { ChannelState } from "@/lib/notifications-core";
import { useFormAction } from "@/lib/use-form-action";
import { cn } from "@/lib/utils";

type FormAction = (previous: ChannelState, formData: FormData) => Promise<ChannelState>;

const TYPES = [
  { value: "failed", label: "Failed backups" },
  { value: "missed", label: "Missed backups" },
  { value: "stale", label: "Backups past their SLA" },
] as const;

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  return message ? (
    <p id={id} className="mt-1.5 text-sm text-destructive">
      {message}
    </p>
  ) : null;
}

function Check({
  name,
  value,
  label,
  checked,
  onChange,
}: {
  name: string;
  value?: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        name={name}
        value={value ?? "on"}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="size-4 accent-[var(--color-iris)]"
      />
      {label}
    </label>
  );
}

/** Copies a value to the clipboard, and says so. */
function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => setCopied(true));
      }}
    >
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

/**
 * A form for one kind of channel. Once the channel is created, the form is
 * replaced by what the person needs next; for a webhook, that is the signing
 * secret, shown this once.
 */
function ChannelForm({
  kind,
  action,
  onDone,
}: {
  kind: "webhook" | "email";
  action: FormAction;
  onDone: () => void;
}) {
  const [state, submit, pending] = useFormAction<ChannelState>(action, { status: "idle" });
  const id = useId();
  const [name, setName] = useState("");
  const [destination, setDestination] = useState("");
  const [types, setTypes] = useState<string[]>(["failed", "missed", "stale"]);
  const [opened, setOpened] = useState(true);
  const [closed, setClosed] = useState(true);
  const [health, setHealth] = useState(true);
  const [monthly, setMonthly] = useState(true);
  const errors = state.status === "error" ? state.fieldErrors : undefined;
  const field = kind === "webhook" ? "url" : "recipients";

  if (state.status === "ok") {
    return (
      <div className="max-w-xl">
        <Notice kind="ok">{state.message}</Notice>
        {state.signingSecret ? (
          <div className="mt-4">
            <Label htmlFor={`${id}-secret`}>Signing secret</Label>
            <div className="mt-2 flex items-center gap-2">
              <Input
                id={`${id}-secret`}
                readOnly
                value={state.signingSecret}
                className="font-mono text-xs"
                onFocus={(event) => event.target.select()}
              />
              <CopyButton value={state.signingSecret} />
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              Your receiver uses it to check that each request came from here. It is stored
              encrypted and cannot be shown again; if it is lost, delete the channel and add it
              again.
            </p>
          </div>
        ) : null}
        <Button type="button" variant="outline" size="sm" className="mt-4" onClick={onDone}>
          Add another channel
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="max-w-xl">
      <div>
        <Label htmlFor={`${id}-name`}>Name</Label>
        <Input
          id={`${id}-name`}
          name="name"
          className="mt-2"
          maxLength={80}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={
            kind === "webhook" ? "For example: PSA webhook" : "For example: On-call team"
          }
          aria-invalid={errors?.name ? true : undefined}
          aria-describedby={errors?.name ? `${id}-name-error` : undefined}
        />
        <FieldError id={`${id}-name-error`} message={errors?.name} />
      </div>

      <div className="mt-5">
        <Label htmlFor={`${id}-${field}`}>{kind === "webhook" ? "URL" : "Send to"}</Label>
        {kind === "webhook" ? (
          <Input
            id={`${id}-${field}`}
            name="url"
            type="url"
            inputMode="url"
            className="mt-2"
            value={destination}
            onChange={(event) => setDestination(event.target.value)}
            placeholder="https://"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={errors?.url ? true : undefined}
            aria-describedby={`${id}-${field}-help${errors?.url ? ` ${id}-${field}-error` : ""}`}
          />
        ) : (
          <textarea
            id={`${id}-${field}`}
            name="recipients"
            rows={3}
            className="mt-2 w-full rounded-md border border-input bg-background px-3 py-2 text-base text-foreground placeholder:text-subtle-foreground md:text-sm aria-invalid:border-destructive"
            value={destination}
            onChange={(event) => setDestination(event.target.value)}
            placeholder="alex@yourmsp.com, sam@yourmsp.com"
            spellCheck={false}
            aria-invalid={errors?.recipients ? true : undefined}
            aria-describedby={`${id}-${field}-help${errors?.recipients ? ` ${id}-${field}-error` : ""}`}
          />
        )}
        <FieldError id={`${id}-${field}-error`} message={errors?.[field]} />
        <p id={`${id}-${field}-help`} className="mt-2 text-sm text-muted-foreground">
          {kind === "webhook"
            ? "Must be https and reachable from the internet. Requests are signed; you get the secret when the channel is created. The URL is stored encrypted and only its host is shown afterwards."
            : `Up to ${MAX_EMAIL_RECIPIENTS_CLIENT} addresses, separated by commas or new lines. Everyone listed receives the same email.`}
        </p>
      </div>

      <fieldset
        className="mt-6"
        aria-describedby={errors?.incidentTypes ? `${id}-types-error` : undefined}
      >
        <legend className="text-sm font-medium">Tell it about</legend>
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
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          <Check
            name="notifyOpened"
            label="When a problem starts"
            checked={opened}
            onChange={setOpened}
          />
          <Check
            name="notifyClosed"
            label="When it is resolved"
            checked={closed}
            onChange={setClosed}
          />
          <Check
            name="notifyIntegrationHealth"
            label="When an integration fails or recovers"
            checked={health}
            onChange={setHealth}
          />
          <Check
            name="notifyMonthlyReport"
            label="A summary of every client, each month"
            checked={monthly}
            onChange={setMonthly}
          />
        </div>
      </fieldset>

      <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Adding…" : kind === "webhook" ? "Add webhook" : "Add email channel"}
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

/** Choose a kind of channel, then fill in its form. */
export function AddChannel({
  webhookAction,
  emailAction,
  emailAvailable,
}: {
  webhookAction: FormAction;
  emailAction: FormAction;
  emailAvailable: boolean;
}) {
  const [kind, setKind] = useState<"webhook" | "email">(emailAvailable ? "email" : "webhook");
  // A new key gives a fresh, empty form after a channel is created.
  const [round, setRound] = useState(0);

  return (
    <div>
      <div
        role="radiogroup"
        aria-label="Kind of channel"
        className="inline-flex rounded-md border border-line-strong p-0.5"
      >
        {(["email", "webhook"] as const).map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={kind === option}
            onClick={() => setKind(option)}
            className={cn(
              "rounded px-3 py-1.5 text-sm font-medium",
              kind === option
                ? "bg-surface-raised text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option === "email" ? "Email" : "Webhook"}
          </button>
        ))}
      </div>
      <div className="mt-5">
        {kind === "email" && !emailAvailable ? (
          <Notice kind="info" className="max-w-xl">
            Email is not set up on this server yet, so email channels cannot be added. Webhooks work
            now.
          </Notice>
        ) : (
          <ChannelForm
            key={`${kind}-${round}`}
            kind={kind}
            action={kind === "webhook" ? webhookAction : emailAction}
            onDone={() => setRound((n) => n + 1)}
          />
        )}
      </div>
    </div>
  );
}
