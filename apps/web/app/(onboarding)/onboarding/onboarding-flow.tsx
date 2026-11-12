"use client";

import { realVendors, SYNC_INTERVAL_MINUTES, vendors, type VendorId } from "@valtrexia/core";
import { Check } from "lucide-react";
import Link from "next/link";
import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

const STEPS = ["Name your workspace", "Choose a backup source", "Start watching"] as const;

const demoSource = vendors.find((v) => v.availability === "demo");
const sources = [...realVendors, ...(demoSource ? [demoSource] : [])];

/**
 * Three-step setup. Step state is local for now: the authentication step of
 * the build makes "Name your workspace" create the tenant, and the
 * integrations step makes the source choice collect real credentials.
 */
export function OnboardingFlow() {
  const [step, setStep] = useState(0);
  const [workspace, setWorkspace] = useState("");
  const [source, setSource] = useState<VendorId>("datto_bcdr");
  const nameId = useId();

  const chosen = sources.find((s) => s.id === source);

  function submitName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (workspace.trim()) setStep(1);
  }

  return (
    <div>
      <ol className="flex gap-2" aria-label="Setup progress">
        {STEPS.map((label, index) => {
          const state = index < step ? "done" : index === step ? "current" : "upcoming";
          return (
            <li
              key={label}
              aria-current={state === "current" ? "step" : undefined}
              className="flex-1"
            >
              <div
                className={cn(
                  "h-1 rounded-full",
                  state === "upcoming" ? "bg-line" : "bg-iris",
                  state === "done" && "opacity-55",
                )}
              />
              <p
                className={cn(
                  "mt-2 hidden text-sm sm:block",
                  state === "current" ? "text-foreground" : "text-subtle-foreground",
                )}
              >
                {index + 1}. {label}
              </p>
            </li>
          );
        })}
      </ol>

      <p className="mt-3 text-sm text-subtle-foreground sm:hidden">
        Step {step + 1} of {STEPS.length}
      </p>

      <div className="mt-10">
        {step === 0 ? (
          <form onSubmit={submitName}>
            <h1 className="font-wide text-3xl font-semibold tracking-[-0.02em]">{STEPS[0]}</h1>
            <p className="mt-3 max-w-prose leading-relaxed text-muted-foreground">
              A workspace holds your clients, vendors and team. Most providers use their company
              name.
            </p>
            <div className="mt-8 max-w-sm">
              <Label htmlFor={nameId}>Workspace name</Label>
              <Input
                id={nameId}
                className="mt-2"
                value={workspace}
                onChange={(event) => setWorkspace(event.target.value)}
                autoComplete="organization"
                required
                maxLength={80}
              />
            </div>
            <Button type="submit" className="mt-8">
              Continue
            </Button>
          </form>
        ) : null}

        {step === 1 ? (
          <div>
            <h1 className="font-wide text-3xl font-semibold tracking-[-0.02em]">{STEPS[1]}</h1>
            <p className="mt-3 max-w-prose leading-relaxed text-muted-foreground">
              Pick where backup results come from. Access is read-only: backup jobs are never
              started, stopped or changed.
            </p>
            <fieldset className="mt-8">
              <legend className="sr-only">Backup source</legend>
              <div className="grid gap-2">
                {sources.map((option) => {
                  const planned = option.availability === "planned";
                  const selected = option.id === source;
                  return (
                    <label
                      key={option.id}
                      className={cn(
                        "flex items-start gap-3 rounded-lg border p-4",
                        planned ? "opacity-60" : "cursor-pointer hover:bg-surface",
                        selected ? "border-iris bg-surface" : "border-line",
                      )}
                    >
                      <input
                        type="radio"
                        name="source"
                        value={option.id}
                        checked={selected}
                        disabled={planned}
                        onChange={() => setSource(option.id)}
                        className="mt-1 size-4 shrink-0 appearance-none rounded-full border border-line-strong bg-background checked:border-[5px] checked:border-iris disabled:opacity-60"
                      />
                      <span>
                        <span className="font-medium">{option.name}</span>
                        {planned ? (
                          <span className="ml-2 text-sm text-subtle-foreground">Planned</span>
                        ) : null}
                        <span className="mt-1 block text-sm text-muted-foreground">
                          {option.summary}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
            <div className="mt-8 flex gap-3">
              <Button type="button" onClick={() => setStep(2)}>
                Continue
              </Button>
              <Button type="button" variant="ghost" onClick={() => setStep(0)}>
                Back
              </Button>
            </div>
          </div>
        ) : null}

        {step === 2 ? (
          <div>
            <h1 className="font-wide text-3xl font-semibold tracking-[-0.02em]">{STEPS[2]}</h1>
            <p className="mt-3 max-w-prose leading-relaxed text-muted-foreground">
              Backups are checked every {SYNC_INTERVAL_MINUTES} minutes. Clients appear on the
              dashboard after the first check, worst first.
            </p>
            <dl className="mt-8 divide-y divide-line rounded-lg border border-line">
              <div className="flex items-center gap-3 p-4">
                <Check aria-hidden="true" className="size-4 text-iris" />
                <dt className="text-muted-foreground">Workspace</dt>
                <dd className="ml-auto font-medium">{workspace}</dd>
              </div>
              <div className="flex items-center gap-3 p-4">
                <Check aria-hidden="true" className="size-4 text-iris" />
                <dt className="text-muted-foreground">Backup source</dt>
                <dd className="ml-auto font-medium">{chosen?.name}</dd>
              </div>
            </dl>
            <div className="mt-8 flex gap-3">
              <Button asChild>
                <Link href="/dashboard">Open the dashboard</Link>
              </Button>
              <Button type="button" variant="ghost" onClick={() => setStep(1)}>
                Back
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      <p className="mt-12 border-t border-line pt-4 text-sm text-subtle-foreground">
        This is a preview. Nothing is saved until sign-in is connected.
      </p>
    </div>
  );
}
