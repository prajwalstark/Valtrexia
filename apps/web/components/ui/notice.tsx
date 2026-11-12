import { CircleAlert, CircleCheck, Info } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const styles = {
  ok: { icon: CircleCheck, tone: "text-status-success", border: "border-status-success/40" },
  error: { icon: CircleAlert, tone: "text-status-critical", border: "border-status-critical/50" },
  info: { icon: Info, tone: "text-iris", border: "border-line-strong" },
} as const;

/**
 * An inline message. Errors are announced immediately (role="alert");
 * everything else politely (role="status"). The icon carries the meaning as
 * well as the colour.
 */
export function Notice({
  kind,
  children,
  className,
  id,
}: {
  kind: keyof typeof styles;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  const { icon: Icon, tone, border } = styles[kind];
  return (
    <p
      id={id}
      role={kind === "error" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-2.5 rounded-md border bg-surface px-3 py-2.5 text-sm leading-relaxed",
        border,
        className,
      )}
    >
      <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", tone)} />
      <span>{children}</span>
    </p>
  );
}
