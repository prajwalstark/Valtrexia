import { brand } from "@valtrexia/core";
import { cn } from "@/lib/utils";

/**
 * Placeholder mark: an iris, for "always in sight". Three arcs around a pupil.
 * The same geometry lives in public/brand/logo-mark.svg for the favicon.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      className={cn("size-7 text-iris", className)}
    >
      <circle
        cx="16"
        cy="16"
        r="13"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray="21.2 6.03"
        transform="rotate(-78 16 16)"
      />
      <circle
        cx="16"
        cy="16"
        r="7.5"
        stroke="currentColor"
        strokeOpacity="0.45"
        strokeWidth="1.5"
      />
      <circle cx="16" cy="16" r="3.5" fill="currentColor" />
    </svg>
  );
}

/** The mark beside the product name. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <LogoMark />
      <span className="font-wide text-[1.0625rem] font-semibold tracking-[-0.01em] text-foreground">
        {brand.name}
      </span>
    </span>
  );
}
