import { OrganizationSwitcher, UserButton } from "@clerk/nextjs";
import Link from "next/link";
import type { ReactNode } from "react";
import { Wordmark } from "@/components/brand/logo";
import { AppNav } from "@/components/shell/app-nav";
import { Sightline } from "@/components/shell/sightline";
import { Notice } from "@/components/ui/notice";
import { getFleet } from "@/lib/fleet";
import { formatDate } from "@/lib/format";
import { getWorkspace } from "@/lib/workspace";

/**
 * Command-center shell: a side rail on wide screens, a top bar on narrow ones,
 * and the fleet status strip above every page.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  // getFleet() starts with requireTenant(): signed in, second factor in
  // place, workspace selected; it redirects otherwise. Pages and server
  // actions make that check again themselves, because a layout alone does
  // not protect them.
  const { overview, now, session } = await getFleet();
  const workspace = await getWorkspace();
  const isOwner = session.role === "owner";

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[14.5rem_minmax(0,1fr)] print:block">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-surface-raised focus:px-3 focus:py-2 print:hidden"
      >
        Skip to content
      </a>

      <aside className="hidden border-r border-line md:flex md:flex-col md:px-3 md:py-5 print:hidden">
        <Link href="/dashboard" className="self-start rounded-md px-3 py-1">
          <Wordmark />
        </Link>
        <div className="mt-8">
          <AppNav orientation="vertical" isOwner={isOwner} />
        </div>
        <div className="mt-auto flex items-center justify-between gap-2 px-3 pt-6">
          <OrganizationSwitcher hidePersonal afterCreateOrganizationUrl="/dashboard" />
          <UserButton />
        </div>
      </aside>

      <div className="flex min-w-0 flex-col">
        <div className="border-b border-line px-4 pt-3 pb-2 md:hidden print:hidden">
          <div className="flex items-center justify-between gap-3">
            <Link href="/dashboard" className="inline-flex rounded-md">
              <Wordmark />
            </Link>
            <UserButton />
          </div>
          <div className="-mx-1 mt-3 overflow-x-auto">
            <AppNav orientation="horizontal" isOwner={isOwner} />
          </div>
        </div>

        <div className="print:hidden">
          <Sightline overview={overview} now={now} />
        </div>

        <main id="main" className="flex-1 px-4 py-8 md:px-8 md:py-10 print:p-0">
          {workspace.deletion ? (
            <Notice kind="error" className="mb-8 max-w-3xl print:hidden">
              This workspace will be deleted on{" "}
              {formatDate(workspace.deletion.deleteAfter, workspace.timeZone)}. Syncing and
              notifications have stopped.{" "}
              {isOwner ? (
                <Link href="/settings" className="underline underline-offset-2">
                  Cancel in settings
                </Link>
              ) : (
                "An owner can cancel it in settings."
              )}
            </Notice>
          ) : null}
          {children}
        </main>
      </div>
    </div>
  );
}
