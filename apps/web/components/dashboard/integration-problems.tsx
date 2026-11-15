import { CircleAlert, TriangleAlert } from "lucide-react";
import Link from "next/link";
import type { FleetOverview } from "@/lib/dashboard-core";
import { describeIntegrationProblem } from "@/lib/describe";
import { cn } from "@/lib/utils";

/**
 * Integrations whose data cannot be relied on, above everything else on the
 * dashboard. What the page shows below is only as good as the data behind
 * it, so a problem here is said first and in full.
 */
export function IntegrationProblems({
  integrations,
  now,
  className,
}: {
  integrations: FleetOverview["integrations"];
  now: Date;
  className?: string;
}) {
  const { problems, total, stalled } = integrations;
  if (problems.length === 0) return null;

  const serious = problems.some((problem) => problem.state !== "retrying");
  // Every integration has gone quiet at once: that points at the worker, not at a vendor.
  const allStalled = total > 0 && stalled === total;

  return (
    <section
      role={serious ? "alert" : "status"}
      aria-label="Integration problems"
      className={cn(
        "rounded-md border bg-surface px-3 py-2.5 text-sm leading-relaxed",
        serious ? "border-status-critical/50" : "border-status-warning/50",
        className,
      )}
    >
      {allStalled ? (
        <p className="mb-2 font-medium">
          No syncs are finishing. The background worker may not be running, so nothing below is
          being updated.
        </p>
      ) : null}
      <ul className="space-y-2">
        {problems.map((problem) => {
          const { text, action } = describeIntegrationProblem(problem, now);
          const Icon = problem.state === "retrying" ? TriangleAlert : CircleAlert;
          return (
            <li key={problem.id} className="flex items-start gap-2.5">
              <Icon
                aria-hidden="true"
                className={cn(
                  "mt-0.5 size-4 shrink-0",
                  problem.state === "retrying" ? "text-status-warning" : "text-status-critical",
                )}
              />
              <span>
                {text}{" "}
                <Link
                  href={`/integrations/${problem.id}`}
                  className="whitespace-nowrap underline underline-offset-4"
                >
                  {action}
                </Link>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
