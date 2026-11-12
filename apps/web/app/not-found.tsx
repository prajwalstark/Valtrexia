import Link from "next/link";
import { Wordmark } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-start justify-center gap-6 px-6 sm:px-10 lg:px-14">
      <Wordmark />
      <div className="max-w-md">
        <h1 className="font-wide text-3xl font-semibold tracking-[-0.02em]">
          This page is out of sight
        </h1>
        <p className="mt-3 leading-relaxed text-muted-foreground">
          The address may be mistyped, or the page may have moved.
        </p>
      </div>
      <Button asChild>
        <Link href="/dashboard">Go to dashboard</Link>
      </Button>
    </main>
  );
}
