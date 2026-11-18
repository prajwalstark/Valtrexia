// Run by the migrate image before `prisma migrate deploy`. In production the
// owner connection must verify the database's certificate.
//
// Prisma's migration engine does not read Node's TLS settings, and does not
// treat `sslmode=verify-full` as verification: it connects to a server whose
// certificate it cannot verify. What it does verify is
// `sslmode=require&sslaccept=strict`, with `sslcert=<CA file>` for a
// certificate authority outside the system's (Amazon RDS's, for example).
// Plain JavaScript: the migrate image has no TypeScript runner.

/**
 * Problems with the owner URL for a production migration, as messages that
 * name the setting and never repeat the URL. Empty when it is acceptable.
 * @param {string | undefined} value
 * @returns {string[]}
 */
export function migrationUrlProblems(value) {
  let url;
  try {
    url = new URL(value ?? "");
  } catch {
    return ["DATABASE_URL_OWNER must be a postgres:// URL."];
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    return ["DATABASE_URL_OWNER must be a postgres:// URL."];
  }
  const problems = [];
  if (url.searchParams.get("sslmode") !== "require") {
    problems.push(
      "DATABASE_URL_OWNER must use sslmode=require (with sslaccept=strict): Prisma does not verify certificates under sslmode=verify-full.",
    );
  }
  if (url.searchParams.get("sslaccept") !== "strict") {
    problems.push("DATABASE_URL_OWNER must set sslaccept=strict, so the certificate is verified.");
  }
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.env.NODE_ENV === "production") {
    const problems = migrationUrlProblems(process.env.DATABASE_URL_OWNER);
    if (problems.length > 0) {
      console.error(`Refusing to migrate.\n  ${problems.join("\n  ")}`);
      process.exit(1);
    }
  }
}
