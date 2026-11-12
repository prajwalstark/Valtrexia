/**
 * Single source of truth for product branding.
 *
 * Every UI surface, email, document title and log banner reads from here.
 * The display name must not be written as a string literal anywhere else in
 * source; `brand.test.ts` scans the repository and fails if it is.
 */
export const brand = {
  name: "Valtrexia",
  positioning: "Unified Backup Intelligence",
  tagline: "Every Backup. Every Client. Always in Sight.",
  description:
    "A centralized command center for MSPs to monitor backup infrastructure across vendors, " +
    "detect failures and missed backups, and keep every protected client asset in sight.",
  logo: {
    /** Paths are relative to the web app's public directory. */
    mark: "/brand/logo-mark.svg",
    wordmark: "/brand/logo-wordmark.svg",
  },
} as const;

export type Brand = typeof brand;

/** "<page> · <name>" for document titles; just the name when no page is given. */
export function pageTitle(page?: string): string {
  return page ? `${page} · ${brand.name}` : brand.name;
}

/** "<name> — <positioning>", used on auth screens and in metadata. */
export function brandLine(): string {
  return `${brand.name} — ${brand.positioning}`;
}
