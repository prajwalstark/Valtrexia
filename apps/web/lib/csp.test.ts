import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contentSecurityPolicy } from "./csp";

// The policy is applied in three places that must stay together: the proxy
// sets it with a nonce, the root layout renders every page per request so
// the nonce reaches the page, and ClerkProvider puts it on Clerk's scripts.
// Each was checked in a browser; these tests stop any one being dropped.

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = (file: string) => readFileSync(join(webRoot, file), "utf8");

describe("content security policy", () => {
  it("is strict, and closes what Clerk's defaults leave open", () => {
    expect(contentSecurityPolicy).toEqual({
      strict: true,
      directives: {
        "frame-ancestors": ["none"],
        "base-uri": ["self"],
        "object-src": ["none"],
      },
    });
  });

  it("is applied by the proxy", () => {
    const proxy = source("proxy.ts");
    expect(proxy).toContain('import { contentSecurityPolicy } from "@/lib/csp"');
    expect(proxy).toMatch(/contentSecurityPolicy:\s*\{\s*strict: contentSecurityPolicy\.strict/);
  });

  it("reaches every page: rendered per request, and Clerk given the nonce", () => {
    const layout = source("app/layout.tsx");
    expect(layout).toMatch(/await connection\(\);/);
    expect(layout).toMatch(/<ClerkProvider[^>]*\bdynamic\b/);
  });

  it("keeps a floor in the static headers for responses the proxy does not see", () => {
    expect(source("next.config.ts")).toContain(
      "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
    );
  });
});
