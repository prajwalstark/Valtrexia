import Link from "next/link";
import type { ReactNode } from "react";
import { Wordmark } from "@/components/brand/logo";
import { AppNav } from "@/components/shell/app-nav";
import { Sightline } from "@/components/shell/sightline";

/**
 * Command-center shell: a side rail on wide screens, a top bar on narrow ones,
 * and the fleet status strip above every page.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh md:grid md:grid-cols-[14.5rem_minmax(0,1fr)]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-surface-raised focus:px-3 focus:py-2"
      >
        Skip to content
      </a>

      <aside className="hidden border-r border-line md:flex md:flex-col md:px-3 md:py-5">
        <Link href="/dashboard" className="self-start rounded-md px-3 py-1">
          <Wordmark />
        </Link>
        <div className="mt-8">
          <AppNav orientation="vertical" />
        </div>
        {/* The workspace switcher and account menu sit here once sign-in is connected. */}
      </aside>

      <div className="flex min-w-0 flex-col">
        <div className="border-b border-line px-4 pt-3 pb-2 md:hidden">
          <Link href="/dashboard" className="inline-flex rounded-md">
            <Wordmark />
          </Link>
          <div className="-mx-1 mt-3 overflow-x-auto">
            <AppNav orientation="horizontal" />
          </div>
        </div>

        <Sightline />

        <main id="main" className="flex-1 px-4 py-8 md:px-8 md:py-10">
          {children}
        </main>
      </div>
    </div>
  );
}
