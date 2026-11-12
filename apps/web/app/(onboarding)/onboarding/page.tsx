import type { Metadata } from "next";
import { Wordmark } from "@/components/brand/logo";
import { OnboardingFlow } from "./onboarding-flow";

export const metadata: Metadata = { title: "Set up your workspace" };

export default function OnboardingPage() {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col px-6 py-8 sm:px-10 sm:py-12">
      <Wordmark />
      <main className="mt-12 flex-1 sm:mt-16">
        <OnboardingFlow />
      </main>
    </div>
  );
}
