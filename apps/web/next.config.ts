import { existsSync } from "node:fs";
import { join } from "node:path";
import type { NextConfig } from "next";

// One .env at the repository root serves the web app, the worker and the
// database tooling. Next.js only looks beside its own package.json, so load
// the shared file here. Variables already set in the environment win.
const rootEnv = join(import.meta.dirname, "..", "..", ".env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source, so Next compiles them.
  transpilePackages: ["@valtrexia/core", "@valtrexia/db", "@valtrexia/connectors"],
  poweredByHeader: false,
};

export default nextConfig;
