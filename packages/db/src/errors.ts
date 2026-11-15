/** A tenant id that is not a UUID was passed to `withTenant`. */
export class InvalidTenantIdError extends Error {
  constructor() {
    // The value is deliberately not echoed: it came from outside.
    super("Tenant id must be a UUID.");
    this.name = "InvalidTenantIdError";
  }
}

/** The application is connected to Postgres as a role that is too powerful. */
export class UnsafeDatabaseRoleError extends Error {
  constructor(role: string, reasons: string[]) {
    super(
      `Refusing to run as database role "${role}": ${reasons.join("; ")}. ` +
        "Connect as valtrexia_app, which is subject to row-level security.",
    );
    this.name = "UnsafeDatabaseRoleError";
  }
}
