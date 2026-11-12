import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { brand, brandLine, pageTitle, taglineLines } from "./brand";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Directories that hold application source. Docs at the repo root may name the product. */
const SOURCE_ROOTS = ["apps", "packages"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".css", ".html", ".mdx"]);
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "coverage", ".turbo", "generated"]);

/** The only files allowed to contain the display name or tagline as a literal. */
const ALLOWED = new Set([
  join("packages", "core", "src", "brand.ts"),
  join("packages", "core", "src", "brand.test.ts"),
]);

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(join(dir, entry.name));
    } else if (SOURCE_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf(".")))) {
      yield join(dir, entry.name);
    }
  }
}

describe("brand config", () => {
  it("exposes the product name, positioning and tagline", () => {
    expect(brand.name).toBe("Valtrexia");
    expect(brand.positioning).toBe("Unified Backup Intelligence");
    expect(brand.tagline).toBe("Every Backup. Every Client. Always in Sight.");
  });

  it("builds titles from the brand name", () => {
    expect(pageTitle()).toBe(brand.name);
    expect(pageTitle("Dashboard")).toBe(`Dashboard · ${brand.name}`);
    expect(brandLine()).toBe(`${brand.name} — ${brand.positioning}`);
  });

  it("splits the tagline into one sentence per line", () => {
    expect(taglineLines()).toEqual(["Every Backup.", "Every Client.", "Always in Sight."]);
    expect(taglineLines().join(" ")).toBe(brand.tagline);
  });

  it("is the only place the display name, positioning or tagline is hard-coded", () => {
    // Case-sensitive on purpose: lowercase identifiers such as the package
    // scope, database role names and env var prefixes are not branding.
    const literals = [brand.name, brand.positioning, brand.tagline];
    const offenders: string[] = [];

    for (const root of SOURCE_ROOTS) {
      for (const file of walk(join(repoRoot, root))) {
        const rel = relative(repoRoot, file);
        if (ALLOWED.has(rel)) continue;
        const text = readFileSync(file, "utf8");
        const hit = literals.find((literal) => text.includes(literal));
        if (hit) offenders.push(`${rel.split(sep).join("/")} contains "${hit}"`);
      }
    }

    expect(offenders, "import `brand` from @valtrexia/core instead").toEqual([]);
  });
});
