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
  web/            Next.js app. Added in step 2.
packages/
  core/           Pure logic with no I/O: brand config now; rules and crypto later.
  db/             Database client, migrations, tenant-scoped access. Step 3.
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

5. Check that everything is wired up.

   ```bash
   pnpm check
   ```

Database migrations, seeding and the web app's dev server are added in later steps; this section grows with them.

### Local database roles

Compose creates two Postgres roles, both configured in `.env`:

| Role              | Used by                        | Privileges                                                        |
| ----------------- | ------------------------------ | ----------------------------------------------------------------- |
| `valtrexia_owner` | Migrations and the seed script | Owns the schema                                                   |
| `valtrexia_app`   | The web app and the worker     | Not a superuser, cannot bypass row-level security, owns no tables |

The app role is created by `docker/postgres/init/01-app-role.sh`, which only runs when the data volume is first created. If you change `APP_DB_USER` or `APP_DB_PASSWORD` afterwards, recreate the volume:

```bash
docker compose down --volumes
```

That deletes all local data.

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
- **No secrets in the repository.** Only `.env.example` is committed, and it contains local-development placeholders.
- **Never log credentials or raw vendor payloads.**
- **Ask before adding a dependency** that is not already in the plan.
