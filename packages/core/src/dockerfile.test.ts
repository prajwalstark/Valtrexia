import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (file: string) => readFileSync(join(repoRoot, file), "utf8");
const dockerfile = read("Dockerfile");
const smoke = read("docker/smoke/run.sh");

/** Every image reference: base images in ARG and FROM lines, and the smoke test's services. */
const imageRefs = [
  ...dockerfile.matchAll(/^ARG \w+_IMAGE=(\S+)$/gm),
  ...smoke.matchAll(/^\w+_IMAGE="(\S+)"$/gm),
].map((match) => match[1]!);

describe("container images", () => {
  it("pins every image by digest, so a moved tag cannot change what runs", () => {
    expect(imageRefs.length).toBeGreaterThanOrEqual(4);
    for (const ref of imageRefs) {
      expect(ref).toMatch(/^[\w./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/);
    }
    // FROM lines use those arguments or earlier stages, never a bare image.
    for (const [, from] of dockerfile.matchAll(/^FROM (\S+)/gm)) {
      expect(from).toMatch(/^\$\{NODE(_FULL)?_IMAGE\}$|^[a-z-]+$/);
    }
  });

  it("uses the Node version in .nvmrc, and the same one for every image", () => {
    const major = read(".nvmrc").trim();
    const versions = imageRefs
      .filter((ref) => ref.startsWith("node:"))
      .map((ref) => /^node:(\d+\.\d+\.\d+)/.exec(ref)?.[1]);
    expect(versions.length).toBe(2);
    expect(new Set(versions).size).toBe(1);
    expect(versions[0]!.split(".")[0]).toBe(major);
  });

  it("installs the pnpm version package.json names", () => {
    const { packageManager } = JSON.parse(read("package.json")) as { packageManager: string };
    const installs = [...dockerfile.matchAll(/npm install --global [^\n]*pnpm@(\S+)/g)].map(
      (match) => match[1],
    );
    expect(installs.length).toBeGreaterThan(0);
    for (const version of installs) expect(`pnpm@${version}`).toBe(packageManager);
  });

  it("runs every final image as the unprivileged user", () => {
    for (const target of ["web", "worker", "migrate"]) {
      const stage = dockerfile.split(/^FROM /m).find((part) => part.includes(` AS ${target}\n`));
      expect(stage, target).toBeDefined();
      expect(stage!, target).toMatch(/^USER node$/m);
    }
  });

  it("keeps environment files and local state out of the build", () => {
    const ignored = read(".dockerignore").split("\n");
    for (const entry of [
      "**/.env",
      "**/.env.*",
      "**/node_modules",
      ".git",
      "packages/db/src/generated",
    ]) {
      expect(ignored).toContain(entry);
    }
  });

  it("is built and run in CI", () => {
    expect(read(".github/workflows/ci.yml")).toContain("run: docker/smoke/run.sh");
  });
});
