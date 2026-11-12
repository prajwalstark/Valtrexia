import { brand } from "@valtrexia/core";

// Entry point for the sync worker. The scheduler and the per-integration sync
// job are added in step 9; until then this only proves the workspace wiring.
function main(): void {
  console.log(`${brand.name} worker started. No jobs are registered yet.`);
}

main();
