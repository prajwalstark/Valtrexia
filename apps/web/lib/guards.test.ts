import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Nothing in the framework forces a page or a server action to check who is
// asking. These tests read the source and fail if one forgets, so the rule
// "every tenant page and every action calls the guard" cannot quietly lapse.

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const posix = (path: string) => relative(webRoot, path).split(sep).join("/");

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

/** The ways a file can establish the tenant. Each ends in requireTenant(). */
const GUARD = /\bawait (requireTenant|requireOwner|getFleet)\(\)/;

describe("tenant guard", () => {
  const appPages = [...walk(join(webRoot, "app", "(app)"))].filter((file) =>
    /[\\/](page|layout|route)\.tsx?$/.test(file),
  );

  it("finds the pages it is meant to check", () => {
    expect(appPages.length).toBeGreaterThanOrEqual(6);
  });

  it.each(appPages.map((file) => [posix(file), file]))(
    "%s establishes the tenant before doing anything",
    (_name, file) => {
      expect(readFileSync(file, "utf8")).toMatch(GUARD);
    },
  );

  it("every exported server action starts by establishing the tenant", () => {
    const actionFiles = [...walk(join(webRoot, "lib", "actions"))].filter((f) => f.endsWith(".ts"));
    expect(actionFiles.length).toBeGreaterThanOrEqual(3);

    const unguarded: string[] = [];
    let checked = 0;
    for (const file of actionFiles) {
      const source = readFileSync(file, "utf8");
      expect(source.startsWith('"use server";'), `${posix(file)} is a server action file`).toBe(
        true,
      );
      // Each exported function, with its body up to the next export or the end.
      for (const block of source.split(/^export async function /m).slice(1)) {
        checked += 1;
        const name = block.slice(0, block.indexOf("("));
        const body = block.slice(block.indexOf("{"));
        const firstAwait = body.match(/\bawait [\w.]+\(/)?.[0] ?? "";
        if (!/await (requireTenant|requireOwner)\(/.test(firstAwait)) {
          unguarded.push(`${posix(file)}: ${name} (first call: ${firstAwait || "none"})`);
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(7);
    expect(unguarded, "the first awaited call in a server action must be the guard").toEqual([]);
  });

  it("only lib/db.ts obtains the database handle, so the role check cannot be skipped", () => {
    const offenders: string[] = [];
    for (const dir of ["app", "components", "lib"]) {
      for (const file of walk(join(webRoot, dir))) {
        if (!/\.tsx?$/.test(file) || /\.test\.ts$/.test(file) || posix(file) === "lib/db.ts")
          continue;
        if (/\b(getDb|createDb)\(/.test(readFileSync(file, "utf8"))) offenders.push(posix(file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("client components never import server-only modules", () => {
    const serverOnly =
      // The *-core modules hold the logic behind the pages and reach the
      // database. A client component may take their types, never their code:
      // a value import would bundle the database client into the browser.
      /from "(@\/lib\/(auth|db|keys|server-deps|fleet|request|workspace|[\w-]+-core)|@valtrexia\/(db|connectors|core\/server))"/;
    const offenders: string[] = [];
    for (const dir of ["app", "components"]) {
      for (const file of walk(join(webRoot, dir))) {
        if (!/\.tsx?$/.test(file)) continue;
        const source = readFileSync(file, "utf8");
        if (!source.startsWith('"use client"')) continue;
        const bad = source
          .split("\n")
          .find((line) => serverOnly.test(line) && !line.startsWith("import type"));
        if (bad) offenders.push(`${posix(file)}: ${bad.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("public routes in the proxy are exact, not prefixes that match look-alike paths", () => {
    const proxy = readFileSync(join(webRoot, "proxy.ts"), "utf8");
    const list = proxy.slice(proxy.indexOf("createRouteMatcher(["), proxy.indexOf("]);"));
    const routes = [...list.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      // "/sign-in(.*)" would also match "/sign-in-preview". "/sign-in/(.*)" does not.
      expect(route, `${route} must not be an open-ended prefix`).not.toMatch(/[^/]\(\.\*\)$/);
    }
    expect(routes).toContain("/api/webhooks/clerk");
  });
});
