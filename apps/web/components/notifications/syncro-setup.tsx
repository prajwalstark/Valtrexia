"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import type { ChannelState } from "@/lib/notifications-core";
import type { SyncroSetup } from "@/lib/psa-core";
import { useFormAction } from "@/lib/use-form-action";
import { FieldError, type FormAction } from "./form-parts";

const SELECT =
  "mt-2 h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground";

function Result({ state }: { state: ChannelState }) {
  if (state.status === "ok") return <Notice kind="ok">{state.message}</Notice>;
  if (state.status === "error" && !state.fieldErrors) {
    return <Notice kind="error">{state.message}</Notice>;
  }
  return null;
}

/** Which Syncro customer each client is. Suggestions are preselected but saved only on Save. */
export function MappingForm({
  setup,
  action,
}: {
  setup: SyncroSetup & { live: NonNullable<SyncroSetup["live"]> };
  action: FormAction;
}) {
  const [state, submit, pending] = useFormAction<ChannelState>(action, { status: "idle" });
  const initial = Object.fromEntries(
    setup.mappings.map((row) => [
      row.clientId,
      row.customer?.id ?? setup.suggestions[row.clientId] ?? "",
    ]),
  );
  const [choices, setChoices] = useState<Record<string, string>>(initial);
  const known = new Set(setup.live.customers.map((c) => c.id));
  const suggested = Object.keys(setup.suggestions).filter(
    (id) => choices[id] === setup.suggestions[id],
  );

  return (
    <form onSubmit={submit} noValidate>
      {suggested.length > 0 ? (
        <p className="mb-4 text-sm text-muted-foreground">
          {suggested.length === 1 ? "One client was" : `${suggested.length} clients were`} matched
          to a Syncro customer of the same name, marked “suggested”. Check before saving.
        </p>
      ) : null}
      {!setup.live.complete ? (
        <Notice kind="info" className="mb-4">
          Syncro has more customers than could be read at once. Only the first{" "}
          {setup.live.customers.length} are listed.
        </Notice>
      ) : null}
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-line-strong text-left text-xs text-subtle-foreground">
            <th scope="col" className="w-2/5 py-2 pr-4 font-medium">
              Client
            </th>
            <th scope="col" className="py-2 font-medium">
              Syncro customer
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {setup.mappings.map((row) => {
            const current = row.customer;
            const missing = current && !known.has(current.id);
            return (
              <tr key={row.clientId}>
                <th scope="row" className="py-2 pr-4 text-left font-medium">
                  <label htmlFor={`customer-${row.clientId}`}>{row.clientName}</label>
                  {setup.suggestions[row.clientId] &&
                  choices[row.clientId] === setup.suggestions[row.clientId] ? (
                    <span className="ml-2 rounded-sm border border-iris-dim px-1.5 text-xs font-normal text-iris">
                      suggested
                    </span>
                  ) : null}
                </th>
                <td className="py-2">
                  <select
                    id={`customer-${row.clientId}`}
                    name={`customer:${row.clientId}`}
                    className={SELECT.replace("mt-2 ", "")}
                    value={choices[row.clientId] ?? ""}
                    onChange={(event) =>
                      setChoices((previous) => ({
                        ...previous,
                        [row.clientId]: event.target.value,
                      }))
                    }
                  >
                    <option value="">Not matched: no tickets</option>
                    {missing ? (
                      <option value={current.id}>{current.name} (no longer listed)</option>
                    ) : null}
                    {setup.live.customers.map((customer) => (
                      <option key={customer.id} value={customer.id}>
                        {customer.name}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="mt-5 flex flex-wrap items-center gap-4">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save matches"}
        </Button>
        <Result state={state} />
      </div>
    </form>
  );
}

export function SettingsForm({
  setup,
  action,
}: {
  setup: SyncroSetup & { live: NonNullable<SyncroSetup["live"]> };
  action: FormAction;
}) {
  const [state, submit, pending] = useFormAction<ChannelState>(action, { status: "idle" });
  const id = useId();
  const [problemType, setProblemType] = useState(setup.channel.problemType ?? "");
  const [status, setStatus] = useState(setup.channel.resolvedStatus);
  return (
    <form onSubmit={submit} noValidate className="max-w-xl">
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <Label htmlFor={`${id}-problem`}>Problem type of new tickets</Label>
          <select
            id={`${id}-problem`}
            name="problemType"
            className={SELECT}
            value={problemType}
            onChange={(event) => setProblemType(event.target.value)}
          >
            <option value="">Syncro’s default</option>
            {setup.live.problemTypes.map((type) => (
              <option key={type}>{type}</option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor={`${id}-status`}>Status when the asset recovers</Label>
          <select
            id={`${id}-status`}
            name="resolvedStatus"
            className={SELECT}
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            {setup.live.statuses.includes(status) ? null : <option value={status}>{status}</option>}
            {setup.live.statuses.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-4">
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? "Saving…" : "Save ticket settings"}
        </Button>
        <Result state={state} />
      </div>
    </form>
  );
}

export function TokenForm({ action }: { action: FormAction }) {
  const [state, submit, pending] = useFormAction<ChannelState>(action, { status: "idle" });
  const id = useId();
  const error = state.status === "error" ? state.fieldErrors?.apiToken : undefined;
  return (
    <form onSubmit={submit} noValidate className="max-w-xl">
      <Label htmlFor={`${id}-token`}>New API token</Label>
      <Input
        id={`${id}-token`}
        name="apiToken"
        type="password"
        className="mt-2 font-mono"
        autoComplete="off"
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-token-error` : undefined}
      />
      <FieldError id={`${id}-token-error`} message={error} />
      <div className="mt-4 flex flex-wrap items-center gap-4">
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? "Checking with Syncro…" : "Replace token"}
        </Button>
        <Result state={state} />
      </div>
    </form>
  );
}
