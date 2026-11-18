/**
 * Whether this web server can serve requests: the database answers as the
 * app role, and Redis answers when it is configured. Used by the load
 * balancer and the container platform, so it says nothing about the system
 * beyond "ready" or "not ready", and names no host, version or error.
 */
export interface ReadinessChecks {
  database: () => Promise<void>;
  /** Absent when this server has no Redis configured (development only). */
  redis?: () => Promise<void>;
}

export type Readiness = { ready: true } | { ready: false; failed: string[] };

/** Runs every check at once, each bounded by `timeoutMs`. */
export async function checkReadiness(
  checks: ReadinessChecks,
  timeoutMs = 2_000,
): Promise<Readiness> {
  const entries = Object.entries(checks).filter(
    (entry): entry is [string, () => Promise<void>] => typeof entry[1] === "function",
  );
  const outcomes = await Promise.all(
    entries.map(async ([name, check]) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          check(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("timed out")), timeoutMs);
          }),
        ]);
        return null;
      } catch {
        return name;
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  const failed = outcomes.filter((name): name is string => name !== null);
  return failed.length === 0 ? { ready: true } : { ready: false, failed };
}
