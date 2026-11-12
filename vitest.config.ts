import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        // Pure logic. No services required.
        test: {
          name: "unit",
          environment: "node",
          include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
          exclude: ["**/*.db.test.ts", "**/node_modules/**", "**/generated/**"],
        },
      },
      {
        // Runs against a real Postgres: row-level security cannot be tested
        // with a fake. The global setup builds a throwaway database.
        test: {
          name: "db",
          environment: "node",
          include: ["packages/*/src/**/*.db.test.ts"],
          globalSetup: ["packages/db/test/global-setup.ts"],
          fileParallelism: false,
          testTimeout: 20_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
