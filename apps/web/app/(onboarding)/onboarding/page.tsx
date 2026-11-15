import { auth } from "@clerk/nextjs/server";
import { isMockAllowed } from "@valtrexia/connectors";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Wordmark } from "@/components/brand/logo";
import { OnboardingFlow } from "./onboarding-flow";

export const metadata: Metadata = { title: "Set up your workspace" };

export default async function OnboardingPage() {
  // A session still waiting to choose an organization counts as signed in here.
  const session = await auth({ treatPendingAsSignedOut: false });
  if (!session.userId) redirect("/sign-in");

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col px-6 py-8 sm:px-10 sm:py-12">
      <Wordmark />
      <main className="mt-12 flex-1 sm:mt-16">
        <OnboardingFlow demoAvailable={isMockAllowed(process.env)} />
      </main>
    </div>
  );
}
