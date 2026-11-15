"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { navItems } from "@/lib/navigation";
import { cn } from "@/lib/utils";

/** Primary navigation. Vertical in the side rail, horizontal in the mobile bar. */
export function AppNav({ orientation }: { orientation: "vertical" | "horizontal" }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Primary">
      <ul className={cn("flex gap-1", orientation === "vertical" ? "flex-col" : "flex-row")}>
        {navItems.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  active
                    ? "bg-surface-raised text-foreground"
                    : "text-muted-foreground hover:bg-surface hover:text-foreground",
                )}
              >
                <Icon aria-hidden="true" className={cn("size-4", active && "text-iris")} />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
