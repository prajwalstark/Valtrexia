import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "prisma/config";

// Prisma does not read .env files itself. Load the repository's .env when it
// exists; in CI and production the variables are already in the environment.
const envFile = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    // Migrations run as the owner role. The running app never uses this URL.
    // `generate` does not connect, so a missing URL only matters for migrate.
    url: process.env.DATABASE_URL_OWNER ?? "",
  },
});
