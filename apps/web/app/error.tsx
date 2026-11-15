"use client";

import Link from "next/link";
import { Wordmark } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";

/**
 * Shown when a page fails to render. It says what the person can do and
 * nothing about what broke: the error's own text may describe internals, so
 * it is never displayed. `digest` is an opaque reference that matches the
 * server log entry, which is where the detail belongs.
 */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex min-h-dvh flex-col items-start justify-center gap-6 px-6 sm:px-10 lg:px-14">
      <Wordmark />
      <div className="max-w-md">
        <h1 className="font-wide text-3xl font-semibold tracking-[-0.02em]">
          This page could not be loaded
        </h1>
        <p className="mt-3 leading-relaxed text-muted-foreground">
          Something went wrong on our side. Your backup data is not affected. Try again, and if it
          keeps happening, contact whoever runs this workspace.
        </p>
        {error.digest ? (
          <p className="mt-3 text-sm text-subtle-foreground">Reference: {error.digest}</p>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-3">
        <Button type="button" onClick={reset}>
          Try again
        </Button>
        <Button asChild variant="outline">
          <Link href="/dashboard">Go to dashboard</Link>
        </Button>
      </div>
    </main>
  );
}
