# Valtrexia

**Unified Backup Intelligence** — _Every Backup. Every Client. Always in Sight._

A multi-tenant command center for Managed Service Providers: one place to monitor backups across vendors, catch failed and missed backups, and see every protected client asset.

Version 1 is **read-only**. It never starts, stops or changes a backup job.

## Status

Phase 1 is in progress. See [PLAN.md](./PLAN.md) for the design and the full task list.

| Step | What                                                         | State   |
| ---- | ------------------------------------------------------------ | ------- |
| 1    | Monorepo scaffold, Docker Compose, env example, brand config | Done    |
| 2    | App shell: theme, navigation, branded sign-in and onboarding | Done    |
| 3    | Schema, migrations, row-level security                       | Done    |
| 4    | Core: status types, missed-backup rule, envelope encryption  | Done    |
| 5    | Connector interface, mock connector, seed script             | Done    |
| 6    | Clerk auth, MFA enforcement, tenant onboarding               | Done\*  |
| 7    | Integrations page (Datto credentials, test connection)       | Done\*  |
| 8    | Datto BCDR connector                                         | Done\*  |
| 9    | Worker: scheduler, sync job, incidents                       | Next    |
| 10   | Dashboard and client drill-down                              | Pending |
| 11   | 3D fleet constellation with 2D fallback                      | Pending |
| 12   | Final pass                                                   | Pending |

\* Built and tested without a live Clerk instance or real Datto keys. Sign-in, MFA setup and webhook delivery have not been exercised end to end, and the Datto connector has only been run against a stand-in built from an assumed response shape. See [Authentication](#authentication) and [Datto BCDR](#datto-bcdr).

## Repository layout

```
apps/
  worker/         Sync pipeline and seed script. The scheduler and queue arrive in step 9.
  web/            Next.js app: shell, sign-in, onboarding, dashboard, integrations.
packages/
  core/           Shared logic: brand, vendors, statuses, the missed-backup rule, health roll-up,
                  and (server entry only) credential encryption and the redacting logger.
  db/             Prisma schema, migrations, row-level security, tenant-scoped access.
  connectors/     Connector interface, shared HTTP client, the Datto BCDR connector,
                  and the demo (mock) vendor.
docker/           Files mounted into the local Postgres container.
```

Internal packages are consumed as TypeScript source (`exports` points at `src/index.ts`), so there is no build step between packages during development.

## Prerequisites

- Node.js 22 or newer (`.nvmrc` is provided)
- pnpm 10 (`corepack enable` will pick up the version pinned in `package.json`)
- Docker with Compose, for local Postgres 16 and Redis 7

## Setup

1. Install dependencies.

   ```bash
   pnpm install
   ```

2. Create your local environment file.

   ```bash
   cp .env.example .env
   ```

3. Add your Clerk keys to `.env` (see [Authentication](#authentication)), then generate a local key-encryption key and paste the output into `VALTREXIA_LOCAL_KEK`.

   ```bash
   openssl rand -base64 32
   ```

4. Start Postgres and Redis. The command waits until both are healthy.

   ```bash
   pnpm infra:up
   ```

5. Apply the database migrations.

   ```bash
   pnpm db:migrate
   ```

6. Load demo data: 12 clients, about 70 assets and two weeks of backup history from the built-in demo vendor.

   ```bash
   pnpm db:seed
   ```

7. Check that everything is wired up. This runs the database tests too, so Postgres must be up.

   ```bash
   pnpm check
   ```

8. Start the web app and open http://localhost:3000.

   ```bash
   pnpm dev
   ```

You will be asked to sign in, set up two-step verification and create a workspace. To attach the demo data to your workspace instead of a placeholder one, run the seed with your Clerk organization id: `SEED_CLERK_ORG_ID=org_... pnpm db:seed`. The dashboard that displays it arrives in step 10.

## Authentication

Sign-in is handled by [Clerk](https://clerk.com). A Clerk organization is a tenant; organization admins are owners and every other member is a technician.

### Clerk setup

1. Create a Clerk application and copy its publishable and secret keys into `.env`.
2. Enable **Organizations**. Requiring organization membership is recommended, so nobody signs in without a workspace.
3. Enable an authenticator app (TOTP) as a second factor and **require multi-factor authentication** for all users.
4. For deployed environments, add a webhook endpoint at `https://<your-host>/api/webhooks/clerk`, subscribe it to the `organization.*` and `organizationMembership.*` events, and copy its signing secret into `CLERK_WEBHOOK_SIGNING_SECRET`.

The exact names of these settings in the Clerk dashboard may differ from the wording above.

### How a request is checked

`proxy.ts` is the outer gate: signed in, or redirected to `/sign-in`. Everything else is decided by `requireTenant()` in `apps/web/lib/auth.ts`, which every page, server action and route handler that touches tenant data calls. In order:

1. **Signed in.**
2. **Multi-factor authentication.** Accepted if the session token shows a second factor was verified in this session, or Clerk confirms the account has one enrolled. Otherwise the user is sent to `/mfa-required`. This is enforced in the app as well as in Clerk, so a misconfigured Clerk instance does not open the door. There is no switch to turn it off.
3. **A workspace is selected.** Otherwise the user is sent to `/onboarding`.
4. **Tenant.** Looked up from the session's organization, and created on first sight. The tenant id is never taken from a URL, form field or header.
5. **User.** The person's record in that tenant is created or brought up to date, following role changes made in Clerk.

`requireOwner()` additionally requires the owner role. Tenant creation, new members, role changes and removals are written to the audit log.

The decision logic lives in `apps/web/lib/session-core.ts` with no Clerk code in it, so it is tested directly against Postgres.

### Webhook

`/api/webhooks/clerk` keeps tenants and members in step with Clerk when changes happen outside a sign-in: an organization renamed, a member added, promoted or removed. Requests are verified by signature before the body is trusted. Handling is idempotent, because webhooks can be delivered more than once and out of order. A removed member is deactivated, not deleted, so the audit trail stays attributable. Deleting an organization in Clerk does **not** delete the tenant's data; that is a deliberate operator action.

The app works without the webhook, since sign-in creates whatever is missing. The webhook matters for changes made while the person is not signed in.

## Integrations

Owners connect vendors on the Integrations page. Technicians can see what is connected and its sync state, but cannot test, change or remove anything.

**Connecting Datto BCDR.** Enter a REST API public key and secret key from the Datto Partner Portal. "Test connection" checks the pair without saving it. "Save and connect" tests it again and only stores it if Datto accepts it, so a mistyped key is caught immediately rather than as a failed sync later. The test reads one device record and changes nothing.

**What happens to the keys.**

- They are validated, tested, encrypted (see [Credentials and logs](#credentials-and-logs)) and stored. Nothing the server sends back to the browser contains a key, a ciphertext or anything derived from the secret key.
- A saved integration shows only the last four characters of its public key. Saved keys cannot be viewed, only replaced.
- "Test connection" on a saved integration decrypts the keys on the server, uses them, and returns only the outcome.
- Connection tests are limited to ten per workspace per minute, so the page cannot be used to try keys against a vendor at speed. The limit is held in memory per web instance.
- Every test, save, replacement and disconnection is written to the audit log with who did it and the outcome, and never with key material.

**Replacing keys** re-tests and re-encrypts, clears any sync error, and makes the integration due for a sync straight away. Backup history is kept.

**Disconnecting** deletes the saved keys and every asset, backup result and incident that came from the integration. Clients are kept. It requires typing the integration's name.

Datto's API root can be overridden with `DATTO_API_BASE_URL` for a sandbox. It is read from server configuration only and never from a request.

The logic is in `apps/web/lib/integrations-core.ts`, with no framework code, and is tested against Postgres with a stand-in for Datto. The server actions in `apps/web/lib/actions/integrations.ts` are thin wrappers around it.

## Connectors

Every vendor implements one interface in `packages/connectors`:

```ts
interface Connector {
  testConnection(): Promise<void>;
  listClients(): Promise<VendorClient[]>;
  listAssets(clientId: string): Promise<VendorAsset[]>;
  listResults(since: Date): Promise<VendorResult[]>;
  normalizeStatus(raw: unknown): NormalizedStatus;
}
```

It is read-only by construction: there is no method that starts, stops or changes a backup job, and the shared HTTP client (`createHttpClient`) can only issue `GET`. That client also handles retries with exponential backoff and jitter, `429` with `Retry-After`, timeouts and a concurrency limit; refuses any request that would leave the vendor's base URL; and logs paths and status codes but never headers or bodies.

Each result keeps the vendor's own record as `rawPayload`. `normalizeStatus` takes that record and maps it to a normalized status, returning `unknown` for anything it does not recognize.

### Datto BCDR

Datto has no "results since" endpoint. Backups are listed inside each asset, and assets inside each device, so the connector reads two endpoints and derives everything from them:

| Interface method | Datto request                                                     |
| ---------------- | ----------------------------------------------------------------- |
| `testConnection` | `GET bcdr/device?_page=1&_perPage=1`                              |
| `listClients`    | `GET bcdr/device` (all pages); one client per distinct customer   |
| `listAssets`     | `GET bcdr/device/{serial}/asset` for each of the client's devices |
| `listResults`    | the `backups[]` array inside each asset, filtered by time         |

One connector instance serves one sync and fetches each device's assets once, however the methods are called. Requests are `GET` only, at most two at a time, authenticated with HTTP Basic (public key, secret key).

**Status mapping** (`normalizeDattoStatus`):

| Datto says                                                | Normalized |
| --------------------------------------------------------- | ---------- |
| Backup failed                                             | `failed`   |
| Backup succeeded; screenshot or local verification failed | `warning`  |
| Backup succeeded; verification passed or not attempted    | `success`  |
| Backup in progress                                        | `running`  |
| Anything else                                             | `unknown`  |

**Failure handling.** A device that disappears between listing and fetching (404) is skipped. Any other failure fetching a device's assets fails the whole sync: carrying on would report success with stale data for that device, and its assets would then be flagged as missed. Individual devices, assets or backup entries that cannot be read are skipped and counted in the log.

**Unverified assumptions.** The connector was written without access to a live Datto account, from Datto's published API description as best recalled. Its tests run against a stand-in that serves the _assumed_ response shape, so they prove the connector is consistent with the assumptions, not that the assumptions are right. Check these against real responses before relying on it:

1. The device list is wrapped as `{ pagination, items }`, and `_page` / `_perPage` work.
2. Which device field names the MSP's customer. The connector prefers `clientCompanyName`, then `organizationId` / `organizationName`, then treats an unassigned device as its own client.
3. Whether the asset list is a bare array or paged. Both are accepted.
4. That an asset's `volume` is a stable key. The asset name is the fallback.
5. The nesting inside `backups[]` (`backup`, `localVerification`, `advancedVerification.screenshotVerification`) and the status strings each uses. Several spellings are accepted for each outcome.
6. That `timestamp` is epoch seconds. Milliseconds and ISO strings are also accepted.
7. Whether failed or in-progress attempts are listed at all, or only snapshots that exist. If only successes are listed, a failure will show up as a missed backup rather than a failed one.
8. Datto's rate limits. The client honours `429` and `Retry-After` and keeps to two concurrent requests.
9. Whether the API exposes each asset's backup schedule. It is assumed not to, so every Datto asset starts with an expected frequency of 24 hours.

Everything that knows Datto's field names is in `packages/connectors/src/datto/schema.ts`, `normalize.ts` and the `clientOf` function in `connector.ts`. Correcting an assumption means editing those and the fixtures in `fixtures.ts`.

### Demo vendor

`MockConnector` is a vendor that exists only in code. It produces a realistic fleet and a rolling backup history with no network access or API keys, so the product runs end to end without real credentials. It always has something to show: an asset on a failing streak, one that has gone silent (missed), one failing screenshot verification, one never backed up, one paused, one archived, one reporting a status the connector does not recognize, and one mid-backup.

Its history is a pure function of the seed and the clock, so it is stable: asking twice gives the same jobs, and asking later gives the same jobs plus the new ones.

The demo vendor is available only when `VALTREXIA_ENABLE_MOCK=true`, and never when `NODE_ENV=production`.

### Sync

`syncIntegration` (in `apps/worker`) pulls one integration's clients, assets and results and stores them. It never holds a database transaction open across a network call, writes everything in one transaction so a failed sync leaves the previous state intact, and is safe to run repeatedly. The first sync reaches back 14 days; later ones re-read 24 hours before the previous sync, so a backup that was still running is completed. A failure is recorded on the integration with a message written for a technician, never raw error text.

## How backup health is decided

The logic is pure functions in `packages/core`, with no database or network access, so it is tested exhaustively.

**Statuses.** Every vendor result is normalized to one of `success`, `warning`, `failed`, `missed`, `running` or `unknown`. A warning still counts as a completed backup: one that succeeded but failed screenshot verification produced a restore point.

**Missed backups** (`evaluateMissedBackup`). An asset is missed when its last completed backup, or its discovery if it has never had one, is more than its expected frequency plus the tenant's grace period ago. The rule returns one of four verdicts:

| Verdict         | When                                                                         | Effect on a missed-backup incident |
| --------------- | ---------------------------------------------------------------------------- | ---------------------------------- |
| `missed`        | No completed backup inside the window                                        | Open one                           |
| `ok`            | A completed backup inside the window                                         | Close it                           |
| `suppressed`    | The asset is archived, paused or muted                                       | Close it                           |
| `indeterminate` | The integration has never synced, is failing, or last synced over 45 min ago | Leave it as it is                  |

`indeterminate` exists so that a vendor outage does not raise a missed-backup incident on every asset that vendor protects.

**Client health** (`summarizeClientHealth`). Red if any watched asset has failed or missed; amber for a warning, an uninterpretable status, or a failing vendor sync; green otherwise; and `none` when a client has no watched assets. Muted, paused and archived assets are left out. Clients sort worst first, then by number of affected assets, then by name.

## Credentials and logs

Vendor credentials are encrypted before they reach the database, with envelope encryption (`@valtrexia/core/server`):

- Each credential set gets its own random data key (AES-256-GCM). The data key is wrapped by a key-encryption key and stored beside the ciphertext.
- Both layers are bound to the tenant id and integration id. A ciphertext copied to another tenant's row, or another integration, will not decrypt.
- The key-encryption key comes from a `KeyProvider`. In development that is `VALTREXIA_LOCAL_KEK`; the local provider refuses to run when `NODE_ENV=production`, where a KMS provider is required. The KMS provider is not written yet.
- Decrypted values come back wrapped in `Secret`, which prints as `[redacted]` if logged, serialized or inspected. The value is only reachable through `.expose()`.

`createLogger` returns a structured JSON logger that redacts before writing: properties named like credentials, tokens, headers or raw vendor payloads at any depth, and credentials embedded in message text (auth headers, `user:password@` URLs, secret query parameters). Redaction is a safety net; do not pass secrets to the logger.

`@valtrexia/core` is safe to import anywhere, including client components. `@valtrexia/core/server` uses Node APIs and must only be imported by server code.

## Tenant isolation

Every MSP is a tenant, and one tenant must never see another's data. That is enforced in Postgres, not only in application code.

| Role              | Used by                    | Privileges                                                        |
| ----------------- | -------------------------- | ----------------------------------------------------------------- |
| `valtrexia_owner` | Migrations only            | Owns the tables                                                   |
| `valtrexia_app`   | The web app and the worker | Not a superuser, cannot bypass row-level security, owns no tables |

- Every table except `tenants` carries `tenant_id` and has a row-level security policy on it.
- Application code reaches tenant data only through `withTenant(tenantId, fn)` from `@valtrexia/db`. It opens a transaction, sets the tenant for that transaction only, and hands `fn` a query client. With no tenant set, every query returns nothing.
- The Prisma client is not exported from `@valtrexia/db`, so there is no way to query outside a tenant by accident.
- Child rows reference their parents by `(tenant_id, id)`, so a row cannot point at another tenant's data even if application code tried.
- Three operations must run before a tenant is known: finding a tenant from a Clerk organization, creating a tenant, and listing which integrations are due to sync. Each is a narrow SQL function that returns ids only.
- `Db.assertSafeRole()` refuses to continue if the app is connected as a superuser, a role that can bypass row-level security, or a table owner.

The policies, grants and functions are hand-written SQL in `packages/db/prisma/migrations/*_tenant_isolation`. `packages/db/src/tenant-isolation.db.test.ts` tests all of it against a real Postgres, and fails if a new table is added without a policy.

### Database roles

With Docker Compose, both roles are created for you from `.env`. The app role is created by `docker/postgres/init/01-app-role.sh`, which only runs when the data volume is first created. If you change `APP_DB_PASSWORD` afterwards, recreate the volume (this deletes all local data):

```bash
docker compose down --volumes
```

Without Docker, or on managed Postgres, create the app role yourself before migrating, with a password of your choosing:

```sql
CREATE ROLE valtrexia_app LOGIN PASSWORD '...' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
```

The owner role needs `CREATEDB` to run the database tests, which build and drop a throwaway `<database>_test`.

### Changing the schema

1. Edit `packages/db/prisma/schema.prisma`.
2. Generate the SQL for the change and review it. Prisma does not know about the policies or the partial index on `incidents`, so remove any statement that would drop them.
3. Save it as a new folder under `packages/db/prisma/migrations`. A new table needs `tenant_id`, a composite key if it has children, grants for `valtrexia_app`, and a `tenant_isolation` policy; copy the pattern from the tenant isolation migration.
4. Run `pnpm db:migrate`, `pnpm db:generate` and `pnpm test:db`.

## Commands

| Command            | What it does                                      |
| ------------------ | ------------------------------------------------- |
| `pnpm dev`         | Runs the web app with reload                      |
| `pnpm build`       | Production build of the web app                   |
| `pnpm worker:dev`  | Runs the worker with reload                       |
| `pnpm typecheck`   | Type-checks every package                         |
| `pnpm lint`        | Lints the repository with ESLint                  |
| `pnpm test`        | Runs every test once (needs Postgres)             |
| `pnpm test:unit`   | Runs only the tests that need no services         |
| `pnpm test:db`     | Runs only the database tests                      |
| `pnpm test:watch`  | Runs Vitest in watch mode                         |
| `pnpm format`      | Formats the repository with Prettier              |
| `pnpm check`       | Type check, lint, tests and format check together |
| `pnpm infra:up`    | Starts local Postgres and Redis                   |
| `pnpm infra:down`  | Stops them (data is kept)                         |
| `pnpm db:migrate`  | Applies pending migrations as the owner role      |
| `pnpm db:generate` | Regenerates the Prisma client                     |
| `pnpm db:seed`     | Loads demo data through the real sync pipeline    |

## Conventions

- **Branding lives in one file.** The product name, positioning and tagline are defined in `packages/core/src/brand.ts`. Import `brand` from `@valtrexia/core`; a test fails if any of them is hard-coded elsewhere under `apps/` or `packages/`.
- **One typeface, self-hosted.** Archivo is bundled in `apps/web/app/fonts` under the SIL Open Font License, so builds make no request to a font service. Headings use its wide setting (`font-wide`).
- **Status colours mean status.** Red, amber and green are reserved for backup health. The brand colour is iris; design tokens are in `apps/web/app/globals.css`.
- **UI components follow shadcn/ui.** They live in `apps/web/components/ui`; add more with `pnpm dlx shadcn@latest add <name>` from `apps/web`.
- **No secrets in the repository.** Only `.env.example` is committed, and it contains local-development placeholders.
- **Never log credentials or raw vendor payloads.**
- **Ask before adding a dependency** that is not already in the plan.
