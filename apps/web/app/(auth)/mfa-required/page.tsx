import { SignOutButton, TaskSetupMFA } from "@clerk/nextjs";
import { auth, currentUser } from "@clerk/nextjs/server";
import { brand } from "@valtrexia/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { secondFactorVerified } from "@/lib/session-core";

export const metadata: Metadata = { title: "Set up two-step verification" };

/**
 * Where anyone without a second factor ends up. There is no way past it:
 * every tenant page calls `requireTenant`, which sends them back here.
 */
export default async function MfaRequiredPage() {
  // A session still waiting on a Clerk task counts as signed in here.
  const session = await auth({ treatPendingAsSignedOut: false });
  if (!session.userId) redirect("/sign-in");

  const user = await currentUser({ treatPendingAsSignedOut: false });
  const enrolled = user?.twoFactorEnabled === true;
  if (enrolled || secondFactorVerified(session.factorVerificationAge)) redirect("/dashboard");

  return (
    <div>
      <h1 className="font-wide text-2xl font-semibold tracking-[-0.02em]">
        Set up two-step verification
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
        {brand.name} holds the keys to your clients’ backup systems, so every account needs a second
        step at sign-in. It takes about a minute with an authenticator app.
      </p>
      <div className="mt-6">
        <TaskSetupMFA redirectUrlComplete="/dashboard" />
      </div>
      <p className="mt-6 text-sm text-subtle-foreground">
        Signed in with the wrong account?{" "}
        <SignOutButton redirectUrl="/sign-in">
          <Button variant="link" className="h-auto p-0">
            Sign out
          </Button>
        </SignOutButton>
      </p>
    </div>
  );
}
