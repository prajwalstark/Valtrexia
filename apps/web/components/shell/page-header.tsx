import type { ReactNode } from "react";

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="max-w-2xl">
        <h1 className="font-wide text-2xl font-semibold tracking-[-0.02em] text-balance">
          {title}
        </h1>
        {description ? (
          <p className="mt-2 text-[0.9375rem] leading-relaxed text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {action}
    </header>
  );
}
