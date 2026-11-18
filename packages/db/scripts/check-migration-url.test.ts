import { describe, expect, it } from "vitest";
import { migrationUrlProblems } from "./check-migration-url.mjs";

const base = "postgresql://valtrexia_owner:owner-secret-pw@db.example.internal:5432/valtrexia";

describe("migration URL in production", () => {
  it("accepts verified TLS, with or without a CA file", () => {
    expect(migrationUrlProblems(`${base}?sslmode=require&sslaccept=strict`)).toEqual([]);
    expect(
      migrationUrlProblems(`${base}?sslmode=require&sslaccept=strict&sslcert=/certs/rds.pem`),
    ).toEqual([]);
  });

  it("refuses verify-full, which Prisma's engine does not verify", () => {
    expect(migrationUrlProblems(`${base}?sslmode=verify-full`).join(" ")).toMatch(
      /does not verify certificates under sslmode=verify-full/,
    );
  });

  it.each([
    [base, 2],
    [`${base}?sslmode=require`, 1],
    [`${base}?sslmode=require&sslaccept=accept_invalid_certs`, 1],
    [`${base}?sslmode=disable&sslaccept=strict`, 1],
  ])("refuses %j", (url, count) => {
    expect(migrationUrlProblems(url)).toHaveLength(count);
  });

  it("refuses what is not a postgres URL, and never repeats the URL", () => {
    for (const value of [undefined, "", "nonsense", "mysql://u:owner-secret-pw@h/db"]) {
      const problems = migrationUrlProblems(value);
      expect(problems.length).toBeGreaterThan(0);
      expect(problems.join(" ")).not.toContain("owner-secret-pw");
    }
    expect(migrationUrlProblems(base).join(" ")).not.toContain("owner-secret-pw");
  });
});
