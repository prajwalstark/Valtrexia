import { brand } from "@valtrexia/core";
import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Sign in" };

export default function SignInPage() {
  return (
    <div>
      <h1 className="font-wide text-2xl font-semibold tracking-[-0.02em]">
        Sign in to {brand.name}
      </h1>

      {/*
        Step 6 replaces this notice with Clerk's sign-in form. It is a notice
        rather than a mock form so nobody types a password into a dead field.
      */}
      <div className="mt-6 rounded-lg border border-line bg-surface p-5">
        <p className="font-medium">Sign-in isn’t connected yet</p>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Accounts, multi-factor authentication and workspaces arrive with the authentication step
          of the build. Until then the app is open without an account.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Button asChild>
            <Link href="/dashboard">Open the dashboard</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/onboarding">Preview onboarding</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
