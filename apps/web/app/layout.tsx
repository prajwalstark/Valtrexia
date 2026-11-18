import { ClerkProvider } from "@clerk/nextjs";
import { brand, brandLine } from "@valtrexia/core";
import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { clerkAppearance } from "@/lib/clerk-appearance";
import { clerkPublishableKey } from "@/lib/clerk-keys";
import "./globals.css";

// Archivo, self-hosted (SIL Open Font License, see ./fonts/OFL.txt). One
// variable file covers every weight and the width axis.
const archivo = localFont({
  src: "./fonts/archivo-latin-variable.woff2",
  variable: "--font-archivo",
  weight: "100 900",
  display: "swap",
  declarations: [{ prop: "font-stretch", value: "62% 125%" }],
});

export const metadata: Metadata = {
  title: { default: brandLine(), template: `%s · ${brand.name}` },
  description: brand.description,
  applicationName: brand.name,
  icons: { icon: brand.logo.mark },
  // A private application: nothing here should be in a search index.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#0e1630",
};

/** The key as a prop when it is set; without it, Clerk reports a clear error. */
function publishableKeyProp(): { publishableKey?: string } {
  const key = clerkPublishableKey();
  return key ? { publishableKey: key } : {};
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Every page is rendered per request: the Content-Security-Policy's nonce
  // is new each time, and a page built ahead of time could not carry it, so
  // its scripts would be blocked (lib/csp.ts).
  await connection();
  return (
    <ClerkProvider
      // Puts the request's CSP nonce on Clerk's scripts (see lib/csp.ts).
      dynamic
      {...publishableKeyProp()}
      appearance={clerkAppearance}
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      signInFallbackRedirectUrl="/dashboard"
      signUpFallbackRedirectUrl="/onboarding"
      afterSignOutUrl="/sign-in"
      // Where Clerk sends a session that still has something to complete.
      taskUrls={{ "setup-mfa": "/mfa-required", "choose-organization": "/onboarding" }}
    >
      <html lang="en" className={archivo.variable}>
        <body>{children}</body>
      </html>
    </ClerkProvider>
  );
}
