"use client";

import { MAX_GRACE_HOURS, MIN_GRACE_HOURS } from "@valtrexia/core";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useFormAction } from "@/lib/use-form-action";
import type { WorkspaceState } from "@/lib/workspace-core";
import { cn } from "@/lib/utils";

const selectClass =
  "h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-base text-foreground md:text-sm aria-invalid:border-destructive";

export function WorkspaceSettingsForm({
  action,
  timeZone,
  graceHours,
  zones,
}: {
  action: (previous: WorkspaceState, formData: FormData) => Promise<WorkspaceState>;
  timeZone: string;
  graceHours: number;
  /** Every zone on offer, with its label already written by the server. */
  zones: readonly { value: string; label: string }[];
}) {
  const [state, submit, pending] = useFormAction<WorkspaceState>(action, { status: "idle" });
  const [zone, setZone] = useState(timeZone);
  const [grace, setGrace] = useState(String(graceHours));
  const id = useId();
  const errors = state.status === "error" ? state.fieldErrors : undefined;

  return (
    <form onSubmit={submit} noValidate className="max-w-xl">
      <div>
        <Label htmlFor={`${id}-zone`}>Time zone</Label>
        <select
          id={`${id}-zone`}
          name="timeZone"
          value={zone}
          onChange={(event) => setZone(event.target.value)}
          className={cn(selectClass, "mt-2")}
          aria-invalid={errors?.timeZone ? true : undefined}
          aria-describedby={`${id}-zone-help${errors?.timeZone ? ` ${id}-zone-error` : ""}`}
        >
          {zones.map((zone) => (
            <option key={zone.value} value={zone.value}>
              {zone.label}
            </option>
          ))}
        </select>
        {errors?.timeZone ? (
          <p id={`${id}-zone-error`} className="mt-1.5 text-sm text-destructive">
            {errors.timeZone}
          </p>
        ) : null}
        <p id={`${id}-zone-help`} className="mt-2 text-sm text-muted-foreground">
          Dates and times are shown in this zone, and each day in an asset’s history is a day here.
          Nothing stored changes.
        </p>
      </div>

      <div className="mt-8">
        <Label htmlFor={`${id}-grace`}>Grace period</Label>
        <div className="mt-2 flex items-center gap-2">
          <Input
            id={`${id}-grace`}
            name="graceHours"
            type="number"
            inputMode="numeric"
            min={MIN_GRACE_HOURS}
            max={MAX_GRACE_HOURS}
            step={1}
            value={grace}
            onChange={(event) => setGrace(event.target.value)}
            className="w-28"
            aria-invalid={errors?.graceHours ? true : undefined}
            aria-describedby={`${id}-grace-help${errors?.graceHours ? ` ${id}-grace-error` : ""}`}
          />
          <span className="text-sm text-muted-foreground">hours</span>
        </div>
        {errors?.graceHours ? (
          <p id={`${id}-grace-error`} className="mt-1.5 text-sm text-destructive">
            {errors.graceHours}
          </p>
        ) : null}
        <p id={`${id}-grace-help`} className="mt-2 text-sm text-muted-foreground">
          How long past its expected time a backup may be before it counts as missed. It applies to
          every asset: one expected every 24 hours is missed after {24 + graceHours}.
        </p>
      </div>

      <div className="mt-8 flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save settings"}
        </Button>
        {state.status !== "idle" && !(state.status === "error" && state.fieldErrors) ? (
          <p
            role={state.status === "error" ? "alert" : "status"}
            className={cn(
              "text-sm",
              state.status === "error" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {state.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}
