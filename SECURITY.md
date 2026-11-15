# Security

What protects tenant data in this codebase, where each control lives, how it is tested, and what is still open. Written at the end of Phase 1.

## What is being protected

- **Each MSP's data from every other MSP.** Clients, assets, backup history, incidents and audit entries.
- **Vendor credentials.** API keys that can read an MSP's entire backup estate.
- **The vendors themselves.** The product must never start, stop or change a backup job.

## Controls

| Control                                                  | Where                                                                                                                                     | How it is tested                                                                                                       |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Tenant isolation in the database                         | Row-level security policy on every tenant table; `packages/db/prisma/migrations/*_tenant_isolation`                                       | `tenant-isolation.db.test.ts`: read, update, delete, insert and move across tenants, for every table, on real Postgres |
| A new table cannot ship without a policy                 | Same migration pattern                                                                                                                    | Catalog test fails if any table with `tenant_id` lacks a policy, or any table is outside the model                     |
| One route to tenant data                                 | `withTenant` in `packages/db`; the Prisma client is not exported                                                                          | Context does not leak between pooled connections, including 40 interleaved transactions                                |
| No cross-tenant references                               | Composite `(tenant_id, id)` foreign keys                                                                                                  | Inserting a child that points at another tenant's parent is rejected                                                   |
| The app never runs as a privileged database role         | `Db.assertSafeRole()`, called by the web app (`lib/db.ts`) and the worker at start                                                        | Rejects the owner role; passes the runtime role                                                                        |
| Tenant id comes only from the verified session           | `apps/web/lib/session-core.ts`                                                                                                            | `session-core.db.test.ts`; no input exists through which a caller could name a tenant                                  |
| Multi-factor authentication is mandatory                 | `resolveSession`, in the app as well as in Clerk                                                                                          | Sessions without a second factor are refused before anything is provisioned                                            |
| Every page and server action checks the session          | `requireTenant()` / `requireOwner()`                                                                                                      | `guards.test.ts` reads the source and fails if a page or action omits the check                                        |
| Owners only manage integrations                          | Role check inside each function in `integrations-core.ts`                                                                                 | Technician attempts are refused before any vendor call                                                                 |
| Credentials encrypted at rest                            | Envelope encryption, AES-256-GCM, `packages/core/src/crypto`                                                                              | Round trip, tampering in every field, wrong key, spliced envelopes                                                     |
| A ciphertext is useless on another tenant or integration | Tenant and integration ids bound in as authenticated data, at both layers                                                                 | Moving a ciphertext to another tenant or record fails to decrypt                                                       |
| Credentials never return to the browser                  | Queries name their columns; results contain no key material                                                                               | Results, audit entries and logs are searched for every key used in the tests                                           |
| Raw vendor payloads never reach the browser              | `dashboard-core.ts` selects named columns                                                                                                 | Output is searched for payload contents                                                                                |
| Nothing sensitive in logs                                | `createLogger` redacts by property name and scrubs message text; `Secret` prints as `[redacted]`                                          | Credentials passed every way a caller might, including child loggers and errors                                        |
| Read-only towards vendors                                | The connector interface has no write method; the HTTP client only issues `GET`                                                            | Every request made in the connector tests is asserted to be `GET`                                                      |
| Requests cannot be redirected to another host            | HTTP client refuses paths that leave the base URL, and does not follow redirects; the Datto base URL comes from server configuration only | Absolute, protocol-relative, root-relative and climbing paths are refused                                              |
| Connection tests cannot be used to try keys at speed     | Ten per workspace per minute                                                                                                              | `integrations-core.db.test.ts`, `rate-limit.test.ts`                                                                   |
| Webhooks are authenticated                               | Signature verified before the body is read                                                                                                | Unsigned and forged requests return 400 and create nothing (checked against the built app)                             |
| Audit trail                                              | `audit_logs`; the runtime role has no `UPDATE` or `DELETE` on it                                                                          | Updates and deletes are refused by the database                                                                        |
| Demo vendor cannot run in production                     | `isMockAllowed`                                                                                                                           | Refused when `NODE_ENV=production`, whatever the setting                                                               |
| Local encryption key cannot run in production            | `createKeyProviderFromEnv`                                                                                                                | Refused when `NODE_ENV=production`                                                                                     |
| Baseline response headers                                | `apps/web/next.config.ts`                                                                                                                 | Checked against the built app: no framing, no MIME sniffing, strict referrer, HSTS                                     |
| Errors do not leak internals                             | Vendor and sync errors use messages we wrote; `app/error.tsx` shows no error text                                                         | Connector and sync tests assert the stored and shown messages                                                          |
| No secrets in the repository                             | `.env` is ignored; `.env.example` holds placeholders                                                                                      | Tracked files scanned for key patterns at the end of Phase 1                                                           |

Continuous integration runs the type check, lint, every test and a production build on each push, and `pnpm audit --prod` on each push and weekly. The workflow has read-only access to the repository and uses no secrets; its actions are pinned to commits, and a test fails if any of that changes. At the time of writing the audit reports no known vulnerabilities.

## Not verified

These were built and tested in isolation, but never exercised against the real thing:

- **Clerk.** Sign-in, MFA setup, organization creation and webhook delivery have not been run against a live Clerk instance. The session and webhook logic is tested with Clerk replaced by fixed inputs.
- **Datto.** The connector has never called Datto. Its response shapes are assumptions, listed in the README.
- **The 3D view on a graphics card.** It was only run with software rendering.

## Open items

Not built. Each should be settled before production use.

1. **KMS key provider.** Only the local development provider exists, and it refuses to run in production. The interface is in place; the provider depends on which cloud is chosen.
2. **Key rotation.** Rotating the key-encryption key means re-wrapping each stored data key. There is no tool for that yet.
3. **A full Content-Security-Policy.** Only `frame-ancestors`, `base-uri` and `object-src` are set. A `script-src` policy needs the identity provider's hosts and per-request nonces.
4. **Rate limiting** exists only for connection tests, and is held in memory per web instance. Sign-in is rate limited by Clerk.
5. **Transport security for Postgres and Redis.** Connection strings are taken as given. Production should require TLS and authentication on both.
6. **Tenant offboarding.** Deleting an organization in Clerk does not delete its data. There is no deletion or export procedure yet.
7. **Retention.** Backup results, raw payloads and audit entries are kept indefinitely.
8. **Monitoring and alerting** on the application itself: failed syncs across tenants, queue depth, error rates. A stopped worker is now visible inside the app (assets turn unknown and the dashboard says syncs have stopped), but only to someone looking at it. Nothing pages an operator.
9. **Database backups** of this application's own Postgres.
10. **An independent review.** Nobody other than the author has reviewed this code.

## Reporting a problem

No contact address has been set. Add one here before the product has users.
