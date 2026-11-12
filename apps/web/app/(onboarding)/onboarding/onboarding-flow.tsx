"use client";

import { useOrganizationList } from "@clerk/nextjs";
import { isClerkAPIResponseError } from "@clerk/nextjs/errors";
import { realVendors, SYNC_INTERVAL_MINUTES, vendors, type VendorId } from "@valtrexia/core";
import { Check } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { connectDemoData } from "@/lib/actions/onboarding";
import { cn } from "@/lib/utils";

const STEPS = ["Name your workspace", "Choose a backup source", "Start watching"] as const;
const demoSource = vendors.find((v) => v.availability === "demo");

/**
 * Three-step setup. Step 1 creates a Clerk organization, which becomes the
 * tenant. Step 2 either connects the demo vendor or hands over to the
 * integrations page for real credentials.
 */
export function OnboardingFlow({ demoAvailable }: { demoAvailable: boolean }) {
  const router = useRouter();
  const { isLoaded, createOrganization, setActive, userMemberships } = useOrganizationList({
    userMemberships: { infinite: true },
  });

  const [step, setStep] = useState(0);
  const [workspace, setWorkspace] = useState("");
  const [source, setSource] = useState<VendorId>("datto_bcdr");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const nameId = useId();
  const errorId = useId();

  const sources = [...realVendors, ...(demoAvailable && demoSource ? [demoSource] : [])];
  const chosen = sources.find((s) => s.id === source);
  const existing = userMemberships?.data ?? [];

  function fail(cause: unknown, fallback: string) {
    setError(
      isClerkAPIResponseError(cause) ? (cause.errors[0]?.longMessage ?? fallback) : fallback,
    );
  }

  function submitName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = workspace.trim();
    if (!name || !isLoaded) return;
    setError(null);
    startTransition(async () => {
      try {
        const organization = await createOrganization({ name });
        await setActive({ organization: organization.id });
        setStep(1);
      } catch (cause) {
        fail(cause, "The workspace could not be created. Try again.");
      }
    });
  }

  function openExisting(organizationId: string) {
    if (!isLoaded) return;
    setError(null);
    startTransition(async () => {
      try {
        await setActive({ organization: organizationId });
        router.push("/dashboard");
      } catch (cause) {
        fail(cause, "That workspace could not be opened. Try again.");
      }
    });
  }

  function submitSource() {
    setError(null);
    if (source !== "mock") {
      // Real credentials are entered on the integrations page.
      setStep(2);
      return;
    }
    startTransition(async () => {
      const result = await connectDemoData();
      if (result.ok) setStep(2);
      else setError(result.message);
    });
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
          <>
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
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? errorId : undefined}
                />
              </div>
              <Button type="submit" className="mt-8" disabled={!isLoaded || pending}>
                {pending ? "Creating workspace…" : "Create workspace"}
              </Button>
            </form>

            {existing.length > 0 ? (
              <section className="mt-12 border-t border-line pt-8">
                <h2 className="font-semibold">Or open a workspace you already belong to</h2>
                <ul className="mt-4 divide-y divide-line rounded-lg border border-line">
                  {existing.map((membership) => (
                    <li
                      key={membership.organization.id}
                      className="flex items-center justify-between gap-4 p-4"
                    >
                      <span className="font-medium">{membership.organization.name}</span>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        onClick={() => openExisting(membership.organization.id)}
                      >
                        Open
                      </Button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </>
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
            <Button type="button" className="mt-8" disabled={pending} onClick={submitSource}>
              {pending ? "Connecting…" : "Continue"}
            </Button>
          </div>
        ) : null}

        {step === 2 ? (
          <div>
            <h1 className="font-wide text-3xl font-semibold tracking-[-0.02em]">{STEPS[2]}</h1>
            <p className="mt-3 max-w-prose leading-relaxed text-muted-foreground">
              {source === "mock"
                ? `Demo data is connected. Backups are checked every ${SYNC_INTERVAL_MINUTES} minutes, and clients appear on the dashboard after the first check, worst first.`
                : `Your workspace is ready. Enter your ${chosen?.name ?? "vendor"} API keys next; clients appear on the dashboard after the first check.`}
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
            <Button
              type="button"
              className="mt-8"
              onClick={() => router.push(source === "mock" ? "/dashboard" : "/integrations")}
            >
              {source === "mock" ? "Open the dashboard" : "Enter API keys"}
            </Button>
          </div>
        ) : null}

        {error ? (
          <p id={errorId} role="alert" className="mt-6 text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
