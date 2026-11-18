import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const workflowDir = join(repoRoot, ".github", "workflows");

const workflows = readdirSync(workflowDir)
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .map((name) => ({ name, text: readFileSync(join(workflowDir, name), "utf8") }));

/** Lines that are not comments, so a commented-out example cannot satisfy or trip a check. */
function activeLines(text: string): string[] {
  return text.split("\n").filter((line) => !line.trimStart().startsWith("#"));
}

describe("CI workflows", () => {
  it("exist", () => {
    expect(workflows.map((workflow) => workflow.name)).toContain("ci.yml");
  });

  it.each(workflows)("$name pins every action to a commit", ({ text }) => {
    const uses = activeLines(text).filter((line) => /^\s*(-\s+)?uses:/.test(line));
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) {
      // A tag such as @v4 can be moved to different code; a commit id cannot.
      expect(line).toMatch(/uses: [\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
    }
  });

  it.each(workflows)("$name can only read the repository and uses no secrets", ({ text }) => {
    const lines = activeLines(text);
    const start = lines.findIndex((line) => line === "permissions:");
    expect(start).toBeGreaterThanOrEqual(0);
    const block: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (!line.startsWith(" ")) break;
      block.push(line.trim());
    }
    expect(block).toEqual(["contents: read"]);

    const body = lines.join("\n");
    // Job-level permissions could widen the top-level grant.
    expect(body.match(/^\s*permissions:/gm)).toHaveLength(1);
    expect(body).not.toMatch(/\bsecrets\./);
    // Runs with the base repository's privileges on code from a fork.
    expect(body).not.toContain("pull_request_target");
  });

  it("runs every step of the local check script", () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const check = manifest.scripts.check;
    expect(check).toBeDefined();
    const steps = (check ?? "").split("&&").map((step) => step.trim());
    expect(steps.length).toBeGreaterThan(0);

    const ci = workflows.find((workflow) => workflow.name === "ci.yml");
    const runs = activeLines(ci?.text ?? "").map((line) => line.trim());
    for (const step of steps) {
      expect(runs, `ci.yml does not run "${step}"`).toContain(`run: ${step}`);
    }
  });
});
