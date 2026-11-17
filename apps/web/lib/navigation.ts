import { LayoutDashboard, Plug, Settings, type LucideIcon } from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Shown to workspace owners only. The page itself still checks. */
  ownerOnly?: boolean;
}

/** Primary navigation. Only pages that exist are listed. */
export const navItems: readonly NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/integrations", label: "Integrations", icon: Plug },
  { href: "/settings", label: "Settings", icon: Settings },
];
