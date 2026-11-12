import { OrganizationSwitcher, UserButton } from "@clerk/nextjs";
import Link from "next/link";
import type { ReactNode } from "react";
import { Wordmark } from "@/components/brand/logo";
import { AppNav } from "@/components/shell/app-nav";
import { Sightline } from "@/components/shell/sightline";
import { requireTenant } from "@/lib/auth";

/**
 * Command-center shell: a side rail on wide screens, a top bar on narrow ones,
 * and the fleet status strip above every page.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  // Signed in, second factor in place, workspace selected. Redirects otherwise.
  // Pages and server actions call this again themselves; a layout alone does
  // not protect them.
  await requireTenant();

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
        <div className="mt-auto flex items-center justify-between gap-2 px-3 pt-6">
          <OrganizationSwitcher hidePersonal afterCreateOrganizationUrl="/dashboard" />
          <UserButton />
        </div>
      </aside>

      <div className="flex min-w-0 flex-col">
        <div className="border-b border-line px-4 pt-3 pb-2 md:hidden">
          <div className="flex items-center justify-between gap-3">
            <Link href="/dashboard" className="inline-flex rounded-md">
              <Wordmark />
            </Link>
            <UserButton />
          </div>
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
