import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";

/** Previous and next links for a paged list. Renders nothing for a single page. */
export function Pagination({
  page,
  pageCount,
  href,
  className,
}: {
  page: number;
  pageCount: number;
  /** The link to a given page, keeping whatever filter is applied. */
  href: (page: number) => string;
  className?: string;
}) {
  if (pageCount <= 1) return null;
  const link =
    "inline-flex h-8 items-center gap-1 rounded-md border border-line-strong px-3 text-sm font-medium hover:bg-surface-raised";
  const off = "pointer-events-none opacity-40";
  return (
    <nav aria-label="Pages" className={cn("flex items-center gap-4", className)}>
      <Link
        href={href(page - 1)}
        aria-disabled={page <= 1}
        tabIndex={page <= 1 ? -1 : undefined}
        className={cn(link, page <= 1 && off)}
      >
        <ChevronLeft aria-hidden="true" className="size-4" />
        Previous
      </Link>
      <span className="text-sm text-muted-foreground">
        Page {page} of {pageCount}
      </span>
      <Link
        href={href(page + 1)}
        aria-disabled={page >= pageCount}
        tabIndex={page >= pageCount ? -1 : undefined}
        className={cn(link, page >= pageCount && off)}
      >
        Next
        <ChevronRight aria-hidden="true" className="size-4" />
      </Link>
    </nav>
  );
}

/** A row of links that switch between views of one list, the current one marked. */
export function ViewTabs({
  label,
  tabs,
}: {
  label: string;
  tabs: readonly { href: string; label: string; count?: number; current: boolean }[];
}) {
  return (
    <nav aria-label={label}>
      <ul className="flex flex-wrap gap-1 border-b border-line">
        {tabs.map((tab) => (
          <li key={tab.href}>
            <Link
              href={tab.href}
              aria-current={tab.current ? "page" : undefined}
              className={cn(
                "-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium",
                tab.current
                  ? "border-iris text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.label}
              {tab.count === undefined ? null : (
                <span className="rounded-sm bg-surface-raised px-1.5 text-xs tabular-nums">
                  {tab.count}
                </span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
