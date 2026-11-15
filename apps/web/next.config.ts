import { existsSync } from "node:fs";
import { join } from "node:path";
import type { NextConfig } from "next";

// One .env at the repository root serves the web app, the worker and the
// database tooling. Next.js only looks beside its own package.json, so load
// the shared file here. Variables already set in the environment win.
const rootEnv = join(import.meta.dirname, "..", "..", ".env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

/**
 * Sent with every response. These are the headers that are safe to set
 * without knowing which hosts the identity provider loads scripts from; a
 * full script-src policy needs those hosts and per-request nonces, and is
 * listed in SECURITY.md as work still to do.
 */
const securityHeaders = [
  // The app is never meant to be framed: this blocks clickjacking.
  { key: "X-Frame-Options", value: "DENY" },
  {
    key: "Content-Security-Policy",
    value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  // Browsers ignore this over plain http, so it is harmless on localhost.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source, so Next compiles them.
  transpilePackages: ["@valtrexia/core", "@valtrexia/db", "@valtrexia/connectors"],
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
