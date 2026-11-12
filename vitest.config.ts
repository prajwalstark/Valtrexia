import { defineConfig } from "vitest/config";

// One root config for now. Step 3 adds a separate project for the database
// integration tests, which need a running Postgres.
export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
    environment: "node",
    passWithNoTests: false,
  },
});
