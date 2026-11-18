/**
 * Clerk's publishable key, read when the server runs rather than when it is
 * built, so one image serves every environment.
 *
 * `CLERK_PUBLISHABLE_KEY` is the setting. `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`,
 * the name Clerk's own docs use, is still accepted. Next.js would bake that
 * one into the build if read as `process.env.NEXT_PUBLIC_…`, which is why
 * both are read from the object passed in.
 */
export function clerkPublishableKey(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return (
    env.CLERK_PUBLISHABLE_KEY?.trim() || env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim() || undefined
  );
}
