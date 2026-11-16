"use client";

import {
  MAX_ASSET_HOURS,
  MIN_ASSET_HOURS,
  MUTE_DAY_CHOICES,
  MUTE_REASON_MAX_LENGTH,
  TECHNICIAN_MAX_MUTE_DAYS,
} from "@valtrexia/core";
import { useActionState, useId, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { SettingsState } from "@/lib/asset-settings-core";
import type { AssetMute } from "@/lib/dashboard-core";
import { count, formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

type FormAction = (previous: SettingsState, formData: FormData) => Promise<SettingsState>;
type ButtonAction = () => Promise<SettingsState>;

const IDLE: SettingsState = { status: "idle" };

/** What a form or button last said: a confirmation, or what went wrong. */
function Outcome({ state, className }: { state: SettingsState; className?: string }) {
  if (state.status === "idle") return null;
  // A field's own error is shown beside the field.
  if (state.status === "error" && state.fieldErrors) return null;
  return (
    <p
      role={state.status === "error" ? "alert" : "status"}
      className={cn(
        "text-sm",
        state.status === "error" ? "text-destructive" : "text-muted-foreground",
        className,
      )}
    >
      {state.message}
    </p>
  );
}

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  return message ? (
    <p id={id} className="mt-1.5 text-sm text-destructive">
      {message}
    </p>
  ) : null;
}

const selectClass =
  "h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-base text-foreground disabled:cursor-not-allowed disabled:opacity-50 md:text-sm aria-invalid:border-destructive";

/**
 * Chooses how long to stop watching for, and says why. Technicians are
 * offered only the lengths they may set; the server enforces the same limit.
 */
function MuteForm({
  action,
  canManage,
  submitLabel,
  onSubmit,
  hideOutcome = false,
}: {
  action: FormAction;
  canManage: boolean;
  submitLabel: string;
  /** Called when the form is submitted, before the result is known. */
  onSubmit?: () => void;
  /** True once something else has happened since, and the last result no longer describes the page. */
  hideOutcome?: boolean;
}) {
  const [state, submit, pending] = useActionState(action, IDLE);
  const id = useId();
  const errors = state.status === "error" ? state.fieldErrors : undefined;
  const choices = MUTE_DAY_CHOICES.filter((days) => canManage || days <= TECHNICIAN_MAX_MUTE_DAYS);

  return (
    <form action={submit} noValidate>
      <div className="grid gap-x-3 gap-y-3 sm:grid-cols-[9.5rem_minmax(0,1fr)]">
        <div>
          <Label htmlFor={`${id}-duration`}>Mute for</Label>
          <select
            id={`${id}-duration`}
            name="duration"
            defaultValue="7"
            className={cn(selectClass, "mt-2")}
            aria-invalid={errors?.duration ? true : undefined}
            aria-describedby={errors?.duration ? `${id}-duration-error` : undefined}
          >
            {choices.map((days) => (
              <option key={days} value={days}>
                {count(days, "day")}
              </option>
            ))}
            {canManage ? <option value="indefinite">Until unmuted</option> : null}
          </select>
        </div>
        <div>
          <Label htmlFor={`${id}-reason`}>Reason</Label>
          <Input
            id={`${id}-reason`}
            name="reason"
            className="mt-2"
            maxLength={MUTE_REASON_MAX_LENGTH}
            placeholder="For example: server being replaced this week"
            autoComplete="off"
            aria-invalid={errors?.reason ? true : undefined}
            aria-describedby={errors?.reason ? `${id}-reason-error` : undefined}
          />
        </div>
      </div>
      <FieldError id={`${id}-duration-error`} message={errors?.duration} />
      <FieldError id={`${id}-reason-error`} message={errors?.reason} />
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button type="submit" variant="outline" size="sm" disabled={pending} onClick={onSubmit}>
          {pending ? "Muting…" : submitLabel}
        </Button>
        {hideOutcome ? null : <Outcome state={state} />}
      </div>
      {!canManage ? (
        <p className="mt-2 text-sm text-subtle-foreground">
          Up to {TECHNICIAN_MAX_MUTE_DAYS} days. A workspace owner can mute for longer.
        </p>
      ) : null}
    </form>
  );
}

function UnmuteButton({
  action,
  label,
  onResult,
}: {
  action: ButtonAction;
  label: string;
  /** Receives the result instead of this button showing it, for when the button may disappear. */
  onResult?: (state: SettingsState) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<SettingsState>(IDLE);

  return (
    <span className="inline-flex flex-wrap items-center gap-x-4 gap-y-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await action();
            if (onResult) onResult(result);
            else setState(result);
          })
        }
      >
        {pending ? "Unmuting…" : label}
      </Button>
      <Outcome state={state} />
    </span>
  );
}

/** Expected frequency and SLA. Blank fields are left as they are, for the all-assets form. */
function ExpectationsForm({
  action,
  frequency,
  sla,
  submitLabel,
  allowBlank = false,
}: {
  action: FormAction;
  frequency?: number;
  sla?: number;
  submitLabel: string;
  allowBlank?: boolean;
}) {
  const [state, submit, pending] = useActionState(action, IDLE);
  const id = useId();
  const errors = state.status === "error" ? state.fieldErrors : undefined;
  const field = (name: "expectedFrequencyHours" | "slaHours", label: string, value?: number) => (
    <div>
      <Label htmlFor={`${id}-${name}`}>{label}</Label>
      <div className="mt-2 flex items-center gap-2">
        <Input
          id={`${id}-${name}`}
          name={name}
          type="number"
          inputMode="numeric"
          min={MIN_ASSET_HOURS}
          max={MAX_ASSET_HOURS}
          step={1}
          defaultValue={value}
          placeholder={allowBlank ? "No change" : undefined}
          className="w-28"
          aria-invalid={errors?.[name] ? true : undefined}
          aria-describedby={errors?.[name] ? `${id}-${name}-error` : undefined}
        />
        <span className="text-sm text-muted-foreground">hours</span>
      </div>
      <FieldError id={`${id}-${name}-error`} message={errors?.[name]} />
    </div>
  );

  return (
    <form action={submit} noValidate>
      <div className="flex flex-wrap gap-x-8 gap-y-3">
        {field("expectedFrequencyHours", "A backup is expected every", frequency)}
        {field("slaHours", "Longest without a backup (SLA)", sla)}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button type="submit" variant="outline" size="sm" disabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </Button>
        <Outcome state={state} />
      </div>
    </form>
  );
}

function describeMute(mute: AssetMute): string {
  const until = mute.until ? `until ${formatDate(mute.until)}` : "until someone unmutes it";
  const who = mute.by ? ` by ${mute.by}` : "";
  const when = mute.at ? ` on ${formatDate(mute.at)}` : "";
  return `Muted ${until}${who}${when}.`;
}

/**
 * The settings of one asset, shown when its row is opened: whether it is
 * being watched, and what is expected of it.
 */
export function AssetSettings({
  canManage,
  expectedFrequencyHours,
  configuredSlaHours,
  appliedSlaHours,
  mute,
  muteAction,
  unmuteAction,
  expectationsAction,
}: {
  /** Owners can change expectations and mute without limit. */
  canManage: boolean;
  expectedFrequencyHours: number;
  configuredSlaHours: number;
  /** Never shorter than the backup window, so it can differ from the configured one. */
  appliedSlaHours: number;
  mute: AssetMute | null;
  muteAction: FormAction;
  unmuteAction: ButtonAction;
  expectationsAction: FormAction;
}) {
  return (
    <div className="grid gap-x-12 gap-y-6 lg:grid-cols-2">
      <section>
        <h4 className="text-sm font-semibold">Watching</h4>
        {mute ? (
          <>
            <p className="mt-2 text-sm text-muted-foreground">
              {describeMute(mute)}
              {mute.reason ? <span className="block text-foreground">“{mute.reason}”</span> : null}
            </p>
            <div className="mt-3">
              <UnmuteButton action={unmuteAction} label="Unmute" />
            </div>
          </>
        ) : (
          <>
            <p className="mt-2 mb-3 text-sm text-muted-foreground">
              A muted asset is not judged: its open incidents close and it leaves the health totals
              until the mute ends.
            </p>
            <MuteForm action={muteAction} canManage={canManage} submitLabel="Mute" />
          </>
        )}
      </section>

      <section>
        <h4 className="text-sm font-semibold">Expectations</h4>
        {canManage ? (
          <div className="mt-3">
            <ExpectationsForm
              action={expectationsAction}
              frequency={expectedFrequencyHours}
              sla={configuredSlaHours}
              submitLabel="Save"
            />
          </div>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            A backup is expected every {count(expectedFrequencyHours, "hour")}, with an SLA of{" "}
            {count(configuredSlaHours, "hour")}. Only workspace owners can change these.
          </p>
        )}
        {appliedSlaHours !== configuredSlaHours ? (
          <p className="mt-2 text-sm text-subtle-foreground">
            The SLA is applied as {count(appliedSlaHours, "hour")}: it cannot be shorter than the
            backup window.
          </p>
        ) : null}
      </section>
    </div>
  );
}

/** The same settings applied to every asset of a client that is not archived. */
export function ClientSettings({
  canManage,
  assetCount,
  mutedCount,
  muteAction,
  unmuteAction,
  expectationsAction,
}: {
  canManage: boolean;
  assetCount: number;
  mutedCount: number;
  muteAction: FormAction;
  unmuteAction: ButtonAction;
  expectationsAction: FormAction;
}) {
  const all = assetCount === 1 ? "the 1 asset" : `all ${assetCount} assets`;
  // Unmuting removes the button that was pressed, so its result is kept here;
  // and once it has happened, the mute form's earlier "Muted…" no longer holds.
  const [unmuted, setUnmuted] = useState<SettingsState>(IDLE);
  return (
    <div className="grid gap-x-12 gap-y-6 lg:grid-cols-2">
      <section>
        <h4 className="text-sm font-semibold">Mute {all}</h4>
        <p className="mt-2 mb-3 text-sm text-muted-foreground">
          For a planned outage or a site that is closed. Open incidents on these assets close.
        </p>
        <MuteForm
          action={muteAction}
          canManage={canManage}
          submitLabel={`Mute ${all}`}
          onSubmit={() => setUnmuted(IDLE)}
          hideOutcome={unmuted.status !== "idle"}
        />
        <Outcome state={unmuted} className="mt-3" />
        {mutedCount > 0 ? (
          <div className="mt-4 border-t border-line pt-4">
            <UnmuteButton
              action={unmuteAction}
              onResult={setUnmuted}
              label={
                mutedCount === 1 ? "Unmute the 1 muted asset" : `Unmute ${mutedCount} muted assets`
              }
            />
          </div>
        ) : null}
      </section>

      {canManage ? (
        <section>
          <h4 className="text-sm font-semibold">Expectations for {all}</h4>
          <p className="mt-2 mb-3 text-sm text-muted-foreground">
            Sets every asset to the same values. Leave a field blank to keep each asset’s own.
          </p>
          <ExpectationsForm action={expectationsAction} submitLabel={`Change ${all}`} allowBlank />
        </section>
      ) : null}
    </div>
  );
}
