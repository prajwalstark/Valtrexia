import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { clerkPublishableKey } from "@/lib/clerk-keys";
import { contentSecurityPolicy } from "@/lib/csp";

/**
 * Routes reachable without a completed session.
 *
 * /mfa-required and /onboarding are listed because Clerk sends people there
 * while their session is still pending a task (setting up MFA, choosing an
 * organization). Both pages check for a signed-in user themselves.
 *
 * The webhook is authenticated by its signature, not by a session.
 */
// Each entry matches the route and what is beneath it, and nothing that merely
// starts with the same letters: "/sign-in" and "/sign-in/factor-one", but not
// "/sign-in-anything-else".
const isPublicRoute = createRouteMatcher([
  "/sign-in",
  "/sign-in/(.*)",
  "/sign-up",
  "/sign-up/(.*)",
  "/mfa-required",
  "/mfa-required/(.*)",
  "/onboarding",
  "/onboarding/(.*)",
  "/api/webhooks/clerk",
]);

// This is the outer gate only: signed in or not. Multi-factor authentication,
// tenant membership and roles are enforced in lib/auth.ts, which every page,
// server action and route handler under the app must go through.
export default clerkMiddleware(
  async (auth, request) => {
    if (!isPublicRoute(request)) await auth.protect();
  },
  // A function, so the key is read per request at run time, not at build time.
  () => ({
    ...(clerkPublishableKey() ? { publishableKey: clerkPublishableKey()! } : {}),
    // Without these, a signed-out visitor is sent to Clerk's hosted sign-in
    // page instead of ours. The same values are set on <ClerkProvider>.
    signInUrl: "/sign-in",
    signUpUrl: "/sign-up",
    // A nonce-based policy on every page; see lib/csp.ts.
    contentSecurityPolicy: {
      strict: contentSecurityPolicy.strict,
      directives: {
        "frame-ancestors": [...contentSecurityPolicy.directives["frame-ancestors"]],
        "base-uri": [...contentSecurityPolicy.directives["base-uri"]],
        "object-src": [...contentSecurityPolicy.directives["object-src"]],
      },
    },
  }),
);

export const config = {
  matcher: [
    // Everything except Next.js internals, static files and the health checks.
    "/((?!_next|api/health$|api/ready$|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // API routes, except the health checks: those must answer whatever
    // state Clerk is in, and touch no session.
    "/(api(?!/health$|/ready$)|trpc)(.*)",
  ],
};
