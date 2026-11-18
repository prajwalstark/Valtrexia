/**
 * In production, connections to Postgres and Redis must be encrypted and
 * authenticated: they carry tenant data and encrypted credentials, and a
 * managed database or cache is usually reached over a network we do not own.
 *
 * - Postgres: `sslmode=verify-full`, which checks the server's certificate and
 *   name. Weaker modes are refused, as is `uselibpqcompat`, under which
 *   `require` would stop checking the certificate.
 * - Redis: a `rediss://` URL (TLS, certificate checked) with a password.
 *
 * Errors name the variable and the rule, never the value.
 */
export function assertProductionTransport(
  env: {
    NODE_ENV?: string | undefined;
    DATABASE_URL?: string | undefined;
    REDIS_URL?: string | undefined;
  },
  check: { database?: boolean; redis?: boolean } = { database: true, redis: true },
): void {
  if (env.NODE_ENV !== "production") return;
  const problems: string[] = [];

  if (check.database) {
    const url = parse(env.DATABASE_URL);
    if (!url || !["postgres:", "postgresql:"].includes(url.protocol)) {
      problems.push("DATABASE_URL must be a postgres:// URL.");
    } else {
      if (url.searchParams.get("sslmode") !== "verify-full") {
        problems.push("DATABASE_URL must set sslmode=verify-full in production.");
      }
      if (url.searchParams.has("uselibpqcompat")) {
        problems.push("DATABASE_URL must not set uselibpqcompat in production.");
      }
    }
  }

  if (check.redis) {
    const url = parse(env.REDIS_URL);
    if (!url || url.protocol !== "rediss:") {
      problems.push("REDIS_URL must be a rediss:// (TLS) URL in production.");
    } else if (!url.password) {
      problems.push("REDIS_URL must include a password in production.");
    }
  }

  if (problems.length > 0) {
    throw new Error(`Insecure connection settings.\n  ${problems.join("\n  ")}`);
  }
}

function parse(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
