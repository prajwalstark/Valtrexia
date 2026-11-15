import { brand, taglineLines } from "@valtrexia/core";
import type { ReactNode } from "react";
import { Wordmark } from "@/components/brand/logo";
import { Aperture } from "./aperture";

/**
 * Two-panel frame for sign-in, sign-up and MFA screens. The left panel carries
 * the brand; the right holds whatever form the page provides.
 */
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
      <section className="relative isolate flex flex-col overflow-hidden border-b border-line px-6 py-8 sm:px-10 lg:border-r lg:border-b-0 lg:px-14 lg:py-12">
        {/*
          Anchored to the bottom-right corner and pushed past it by a share of
          its own size, so about a third of the figure shows and it stays clear
          of the text. Hidden on short or narrow viewports where it would not.
        */}
        <Aperture className="pointer-events-none absolute right-0 bottom-0 -z-10 hidden w-[112%] max-w-none translate-x-[33%] translate-y-[59%] lg:[@media(min-height:760px)]:block" />

        <Wordmark />

        <div className="mt-10 lg:mt-[18vh]">
          <p className="font-wide text-[clamp(2rem,4.6vw,4.25rem)] leading-[1.04] font-semibold tracking-[-0.03em]">
            {taglineLines().map((line) => (
              <span key={line} className="block">
                {line}
              </span>
            ))}
          </p>
          <p className="mt-6 max-w-md text-base leading-relaxed text-muted-foreground lg:text-lg">
            {brand.positioning} for managed service providers. One view of every vendor, every
            client and every protected asset.
          </p>
        </div>
      </section>

      <main className="flex items-center justify-center px-6 py-12 sm:px-10">
        <div className="w-full max-w-sm">{children}</div>
      </main>
    </div>
  );
}
