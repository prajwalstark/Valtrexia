# Valtrexia

**Unified Backup Intelligence** — _Every Backup. Every Client. Always in Sight._

A multi-tenant command center for Managed Service Providers: one place to monitor backups across vendors, catch failed and missed backups, and see every protected client asset.

Version 1 is **read-only**. It never starts, stops or changes a backup job.

## Status

Phase 1 is in progress. See [PLAN.md](./PLAN.md) for the design and the full task list.

| Step | What                                                         | State   |
| ---- | ------------------------------------------------------------ | ------- |
| 1    | Monorepo scaffold, Docker Compose, env example, brand config | Done    |
| 2    | App shell: theme, navigation, branded sign-in and onboarding | Next    |
| 3    | Schema, migrations, row-level security                       | Pending |
| 4    | Core: status types, missed-backup rule, envelope encryption  | Pending |
| 5    | Connector interface, mock connector, seed script             | Pending |
| 6    | Clerk auth, MFA enforcement, tenant onboarding               | Pending |
| 7    | Integrations page (Datto credentials, test connection)       | Pending |
| 8    | Datto BCDR connector                                         | Pending |
| 9    | Worker: scheduler, sync job, incidents                       | Pending |
| 10   | Dashboard and client drill-down                              | Pending |
| 11   | 3D fleet constellation with 2D fallback                      | Pending |
| 12   | Final pass                                                   | Pending |

## Repository layout

```
apps/
  worker/         Sync worker (BullMQ). Entry point only, until step 9.
  web/            Next.js app: shell, sign-in, onboarding, dashboard, integrations.
packages/
  core/           Shared logic: brand, vendors, statuses, the missed-backup rule, health roll-up,
                  and (server entry only) credential encryption and the redacting logger.
  db/             Prisma schema, migrations, row-level security, tenant-scoped access.
  connectors/     Vendor connector interface and implementations. Steps 5 and 8.
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

3. Generate a local key-encryption key and paste the output into `VALTREXIA_LOCAL_KEK` in `.env`.

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

6. Check that everything is wired up. This runs the database tests too, so Postgres must be up.

   ```bash
   pnpm check
   ```

7. Start the web app and open http://localhost:3000.

   ```bash
   pnpm dev
   ```

Sign-in is not connected yet, so the app opens without an account. Seeding is added in a later step; this section grows with it.

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

| Command           | What it does                                |
| ----------------- | ------------------------------------------- |
| `pnpm typecheck`  | Type-checks every package                   |
| `pnpm test`       | Runs the Vitest suite once                  |
| `pnpm test:watch` | Runs Vitest in watch mode                   |
| `pnpm format`     | Formats the repository with Prettier        |
| `pnpm check`      | Type check, tests and format check together |
| `pnpm infra:up`   | Starts local Postgres and Redis             |
| `pnpm infra:down` | Stops them (data is kept)                   |
| `pnpm worker:dev` | Runs the worker with reload                 |

## Conventions

- **Branding lives in one file.** The product name, positioning and tagline are defined in `packages/core/src/brand.ts`. Import `brand` from `@valtrexia/core`; a test fails if any of them is hard-coded elsewhere under `apps/` or `packages/`.
- **One typeface, self-hosted.** Archivo is bundled in `apps/web/app/fonts` under the SIL Open Font License, so builds make no request to a font service. Headings use its wide setting (`font-wide`).
- **Status colours mean status.** Red, amber and green are reserved for backup health. The brand colour is iris; design tokens are in `apps/web/app/globals.css`.
- **UI components follow shadcn/ui.** They live in `apps/web/components/ui`; add more with `pnpm dlx shadcn@latest add <name>` from `apps/web`.
- **No secrets in the repository.** Only `.env.example` is committed, and it contains local-development placeholders.
- **Never log credentials or raw vendor payloads.**
- **Ask before adding a dependency** that is not already in the plan.
