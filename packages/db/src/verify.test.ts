import { describe, expect, it } from "vitest";
import { migrationNames } from "./catalog";
import { roleProblems } from "./verify";

describe("runtime role check", () => {
  const safe = { connected_as: "valtrexia_app", superuser: false, bypass_rls: false, owned: 0 };

  it("passes the runtime role as the migrations create it", () => {
    expect(roleProblems(safe)).toEqual([]);
  });

  it("names every way the role could get past tenant isolation", () => {
    expect(roleProblems({ ...safe, superuser: true, bypass_rls: true, owned: 3 })).toEqual([
      "valtrexia_app is a superuser",
      "valtrexia_app can bypass row-level security",
      "valtrexia_app owns 3 tables",
    ]);
    expect(roleProblems(undefined)).toEqual(["the role valtrexia_app does not exist"]);
  });
});

describe("migration names", () => {
  it("lists this codebase's migrations, oldest first", () => {
    const names = migrationNames();
    expect(names.length).toBeGreaterThan(10);
    expect([...names].sort()).toEqual(names);
    expect(names[0]).toMatch(/^\d{14}_init$/);
  });
});
