# Valtrexia — Phase 1 Plan

> Unified Backup Intelligence — _Every Backup. Every Client. Always in Sight._

Status: **approved. Build in progress; see the status table in README.md.**
Section 9 records the decisions taken at approval.

---

## 1. What Phase 1 delivers

A working, read-only, multi-tenant app where an MSP signs in (Clerk, MFA enforced), creates a tenant, adds Datto BCDR credentials, and within 15 minutes sees every client ranked worst-first by backup health, with drill-down to assets and 14 days of results. Everything also runs end-to-end on a mock connector with no vendor keys.

**Out of scope for Phase 1** (schema leaves room, nothing is built): Unitrends and VSPC connectors, outbound notifications (email/PSA/webhooks), per-asset settings UI, reporting, billing. Incidents are opened, closed and shown in-app only.

**Read-only guarantee:** the connector interface has no write methods, and the Datto HTTP client only issues `GET`. A test asserts that.

---

## 2. Stack

As you specified, at current stable versions: Next.js 16 (App Router), React 19, Tailwind 4, shadcn/ui, Clerk, Prisma, PostgreSQL 16, BullMQ on Redis 7, React Three Fiber 9 + drei, Vitest, pnpm workspaces, Docker Compose.

Three choices to flag:

| Choice           | Decision                                                    | Why                                                                                                                                                                                                                                                                 |
| ---------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ORM              | **Prisma**                                                  | Listed first in your brief and matches the model you described. RLS policies, roles and functions go in hand-written SQL migrations, which Prisma supports. I will pin the latest stable release (not the 8.0 RC currently tagged on npm) and tell you the version. |
| Datto client     | **Own thin client, not `@wyre-technology/node-datto-bcdr`** | That package is not on the public npm registry (404 when I checked), so it would need a private registry and token. The connector needs its own pagination, backoff and 429 handling anyway, and the Datto surface we use is four GET endpoints.                    |
| Monorepo tooling | Plain `pnpm -r` scripts, no Turborepo                       | Five packages do not need a build orchestrator yet.                                                                                                                                                                                                                 |

---

## 3. Folder structure

```
valtrexia/
├─ PLAN.md  README.md  .env.example  docker-compose.yml
├─ package.json  pnpm-workspace.yaml  tsconfig.base.json  vitest.workspace.ts
├─ apps/
│  ├─ web/                          Next.js App Router
│  │  ├─ app/
│  │  │  ├─ (auth)/sign-in/  sign-up/  mfa-required/     branded Clerk screens
│  │  │  ├─ (onboarding)/onboarding/                     create tenant → connect vendor / demo data
│  │  │  ├─ (app)/layout.tsx                             command-center shell: sidebar, header
│  │  │  ├─ (app)/dashboard/                             all clients, worst first
│  │  │  ├─ (app)/clients/[clientId]/                    assets + 14-day results
│  │  │  ├─ (app)/integrations/                          list, add Datto, test connection
│  │  │  └─ api/webhooks/clerk/                          org / membership sync
│  │  ├─ components/ui/             shadcn components
│  │  ├─ components/brand/          Logo, Wordmark (read brand config)
│  │  ├─ components/viz/            R3F scene (lazy) + 2D fallback
│  │  ├─ lib/auth.ts                requireTenant(): Clerk session → tenant context
│  │  ├─ lib/actions/               server actions (integrations, incidents)
│  │  └─ proxy.ts                   Clerk route protection (Next 16 name for middleware)
│  └─ worker/
│     └─ src/  index.ts  scheduler.ts  jobs/sync-integration.ts  queues.ts
├─ packages/
│  ├─ core/                         no I/O, pure and fully unit-tested
│  │  └─ src/  brand.ts  status.ts  rules/missed-backup.ts  health.ts
│  │           crypto/envelope.ts  crypto/key-provider.ts  logger.ts
│  ├─ db/
│  │  ├─ prisma/schema.prisma  migrations/  seed.ts
│  │  └─ src/  client.ts  with-tenant.ts  system.ts  repositories/
│  └─ connectors/
│     └─ src/  types.ts  http.ts  registry.ts
│              datto/ (client, connector, normalize, fixtures)
│              mock/  (connector, deterministic fixtures)
```

`packages/core/src/brand.ts` is the single source for the name, positioning, tagline, and logo reference. A test (`brand.test.ts`) scans `apps/` and `packages/` and fails if any of them is hard-coded anywhere else in source.

---

## 4. Data model

All tables have `id uuid`, `createdAt`, `updatedAt`. Every table except `Tenant` carries `tenantId`.

| Model                   | Fields (beyond the above)                                                                                                                                                                                                     | Notes                                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Tenant**              | clerkOrgId (unique), name, graceHours (default 2)                                                                                                                                                                             | One per Clerk organization                                                                                 |
| **User**                | tenantId, clerkUserId, email, name, role (`owner`\|`technician`)                                                                                                                                                              | One row per membership; unique (tenantId, clerkUserId)                                                     |
| **Integration**         | tenantId, vendor, name, credentialsEnc (jsonb), credentialHint, lastSyncAt, lastSyncStartedAt, syncStatus, lastSyncError                                                                                                      | `credentialHint` = last 4 chars of the public key, the only credential-derived value the browser ever sees |
| **Client**              | tenantId, name                                                                                                                                                                                                                | Unique (tenantId, name)                                                                                    |
| **VendorClientMapping** | tenantId, integrationId, clientId, vendorClientId, vendorClientName                                                                                                                                                           | Unique (integrationId, vendorClientId). Lets several vendors map onto one Client                           |
| **Asset**               | tenantId, clientId, integrationId, vendorAssetId, name, type, deviceName, expectedFrequencyHours (24), slaHours (72), mutedUntil, isPaused, isArchived, firstSeenAt, lastSeenAt, _lastResultAt, lastSuccessAt, currentStatus_ | Unique (integrationId, vendorAssetId)                                                                      |
| **BackupResult**        | tenantId, assetId, integrationId, vendorResultId, startedAt, endedAt, status, vendorStatusRaw, message, screenshotVerified (nullable), rawPayload (jsonb)                                                                     | Unique (assetId, vendorResultId) makes sync idempotent. Index (tenantId, assetId, startedAt desc)          |
| **Incident**            | tenantId, assetId, type, openedAt, closedAt, acknowledgedBy, acknowledgedAt                                                                                                                                                   | Partial unique index (assetId, type) where closedAt is null: one open incident per asset per type          |
| **AuditLog**            | tenantId, actorUserId, actorType (`user`\|`system`), action, targetType, targetId, metadata (jsonb), ip                                                                                                                       | Append-only: the app role gets INSERT and SELECT only                                                      |

Enums: `Vendor` = datto_bcdr \| kaseya_uniview \| veeam_vspc \| mock · `BackupStatus` = success \| warning \| failed \| missed \| running \| unknown · `SyncStatus` = never \| running \| ok \| error · `IncidentType` = failed \| missed \| stale (reserved for the SLA rule).

**Additions to your model, in italics above:** three denormalized fields on Asset so the dashboard does not aggregate BackupResult on every load, plus `isPaused`/`isArchived` so paused Datto agents are not reported as missed. Say so if you would rather not have them.

**`missed` is derived, never fabricated.** The rule sets `Asset.currentStatus = missed` and opens an Incident. It does not insert a synthetic BackupResult, so `rawPayload` always holds something a vendor really sent.

---

## 5. Tenant isolation

Layered, so that one application bug does not leak data:

1. **Two database roles.** `valtrexia_owner` runs migrations and owns the tables. `valtrexia_app` is what web and worker connect as: not a superuser, no `BYPASSRLS`, not the table owner.
2. **RLS enabled and forced** on every tenant table:
   `USING (tenant_id = current_setting('app.tenant_id', true)::uuid)` with the same `WITH CHECK`. No context set means the setting is NULL and the query returns zero rows (fails closed).
3. **One way in.** `withTenant(tenantId, fn)` opens a transaction, runs `set_config('app.tenant_id', $1, true)` (transaction-local, so safe with connection pooling), and passes the transaction client to `fn`. Repositories only accept that client; the raw Prisma client is not exported from `packages/db`.
4. **No cross-tenant runtime role.** The three operations that must run before a tenant context exists are narrow `SECURITY DEFINER` functions: `resolve_tenant_id(clerk_org_id)`, `provision_tenant(clerk_org_id, name)`, and `list_due_integrations(interval)` (returns ids only, for the scheduler).
5. **Composite foreign keys** `(tenant_id, id)` on parent/child relations, because FK checks bypass RLS and a plain FK would let a row reference another tenant's parent.
6. **Tenant id always comes from the verified Clerk session**, never from a URL, form field or header.

---

## 6. Key designs

### Credentials (envelope encryption)

- A fresh 256-bit data key per integration encrypts the credentials JSON with AES-256-GCM. The data key is wrapped by a key-encryption key and stored beside the ciphertext: `{v, keyId, wrappedDek, iv, ciphertext, tag}`.
- `tenantId` and `integrationId` are bound in as additional authenticated data, so a ciphertext copied to another tenant's row will not decrypt.
- `KeyProvider` interface with two implementations: `LocalKeyProvider` (key from `VALTREXIA_LOCAL_KEK`, dev only, refuses to start when `NODE_ENV=production`) and a KMS provider for prod (see question 4).
- Node's built-in `crypto` only. Decryption happens in the worker and in the "Test connection" server action. No API route or server component returns the secret; saved integrations show `••••1a2b` and a "Replace credentials" action.
- The logger redacts by key name (`secret`, `password`, `authorization`, `credentials`, `rawPayload`) and never logs request headers.

### Connector interface (`packages/connectors`)

Exactly the five methods you specified. Connectors are built by `createConnector(vendor, credentials, { fetch, logger })`, with `fetch` injectable for tests. A shared `http.ts` provides pagination helpers, retries with exponential backoff and jitter on 5xx and network errors, `Retry-After` handling on 429, a per-integration concurrency cap, and typed errors (`AuthError`, `RateLimitError`, `VendorError`) so the UI can say "bad credentials" rather than "sync failed".

### Datto BCDR mapping

| Interface method   | Datto call                                                          |
| ------------------ | ------------------------------------------------------------------- |
| testConnection     | `GET /bcdr/device?_perPage=1`, 401/403 becomes `AuthError`          |
| listClients        | Distinct organizations across `GET /bcdr/device` (paged)            |
| listAssets         | `GET /bcdr/device/{serial}/asset` for each of the client's devices  |
| listResults(since) | The `backups[]` array embedded in each asset, filtered by timestamp |

Auth is HTTP Basic (public key : secret key). Status rule: backup failed → `failed`; backup succeeded but screenshot or local verification failed → `warning`; succeeded and verification passed or not attempted → `success`; anything unrecognized → `unknown` with the raw value kept in `vendorStatusRaw`.

**Uncertain until I see a real response, all isolated in `datto/`:**

- Exact field names in the asset payload (`backups[].backup.status`, `advancedVerification.screenshotVerification`, `lastSnapshot`), and whether timestamps are epoch seconds.
- Which device field identifies the client organization.
- Datto's published rate limit. I will be conservative and honor 429.
- Whether in-progress backups are exposed at all. If not, `running` is never emitted for Datto.
- Datto has no "results since" endpoint that I know of, so each sync walks device → asset. That is fine at 15-minute intervals but sets the request count per sync.

The connector is built and tested against recorded-shape fixtures; I will flag every assumption in code comments and reconcile them when you provide keys.

### Mock connector

Deterministic (seeded by integration id): about 12 clients, 60 assets, 14 days of results, with scripted scenarios: a failing streak, a missed backup, a screenshot failure, a never-backed-up asset, a paused agent. Enabled only when `VALTREXIA_ENABLE_MOCK=true`. Used by the seed script, the onboarding "Explore with demo data" option, and tests.

### Worker

- One repeating BullMQ `scheduler-tick` job (every 60 s) calls `list_due_integrations('15 minutes')` and enqueues `sync-integration` with a deterministic job id, so an integration is never synced twice concurrently. The database is the source of truth; there are no per-integration schedules to drift.
- `sync-integration`, inside `withTenant`: decrypt → `listClients` → upsert clients and mappings → `listAssets` → upsert assets → `listResults(lastSyncAt − 24 h overlap; 14 days on first sync)` → normalize → upsert results → recompute asset status → run rules → open/close incidents → update `lastSyncAt` / `syncStatus`.
- A failed sync records a sanitized error on the integration and retries with backoff.

### Missed-backup rule (pure function in `packages/core`)

An asset is **missed** when `now − (lastSuccessAt ?? firstSeenAt) > expectedFrequencyHours + graceHours`.
Skipped when the asset is muted, paused or archived, **or when its integration's last sync failed or is itself overdue**: if we could not reach the vendor we do not know that the backup was missed, and the integration shows a sync error instead. The incident closes automatically on the next qualifying backup.

### Dashboard

- Client health roll-up: **red** = any unmuted asset failed or missed; **amber** = any warning or unknown, or the integration's sync is failing; **green** = everything else. Sorted by severity, then number of affected assets, then name.
- Drill-down: asset table with a 14-day strip per asset (one cell per day, worst status of that day), expandable to individual results with message, raw vendor status and screenshot verification.
- Status is never conveyed by color alone: every indicator has an icon and a text label.

### 3D visualization

One scene in Phase 1: a **fleet constellation** at the top of the dashboard. Each client is a node colored and pulsed by health, with its assets orbiting; clicking a node opens the drill-down. Loaded with `next/dynamic` (`ssr: false`), so Three.js is never in the initial bundle. The 2D fallback (a status tile grid) renders instead when the user prefers reduced motion, WebGL2 is unavailable, the device reports low cores or memory, or the user switches it off (remembered). The ranked client list below it is always present, so the 3D view is never the only way to reach information.

---

## 7. Task order

Each step ends with `pnpm typecheck && pnpm test` and a short report of what changed.

| #   | Step                                                                                                      | Verified by                                                        |
| --- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1   | Monorepo scaffold, Docker Compose (Postgres 16, Redis 7), `.env.example`, README, brand config            | Install, typecheck, empty test run                                 |
| 2   | App shell: dark command-center theme, navigation, logo placeholder, static sign-in and onboarding screens | Typecheck, build, screenshots                                      |
| 3   | Schema, migrations, roles, RLS policies, definer functions, `withTenant`                                  | **Tenant isolation tests** against real Postgres                   |
| 4   | Core: status types, missed-backup rule, health roll-up, envelope encryption, redacting logger             | **Missed-rule tests**, crypto round-trip and tamper tests          |
| 5   | Connector interface, HTTP layer, mock connector, seed script                                              | Pagination / backoff / 429 tests, seed runs                        |
| 6   | Clerk auth, MFA enforcement, org → tenant provisioning, webhook, onboarding flow, audit log               | Typecheck, tests; live sign-in needs your Clerk keys               |
| 7   | Integrations page: Datto credential form, "Test connection", encrypted storage                            | Action tests: secret never in any response                         |
| 8   | Datto BCDR connector and normalizer                                                                       | **Normalizer tests** on fixtures, GET-only assertion               |
| 9   | Worker: scheduler, sync job, incident engine                                                              | Sync integration test with mock connector on real Postgres + Redis |
| 10  | Dashboard and client drill-down                                                                           | Typecheck, tests, screenshots on seeded data                       |
| 11  | 3D constellation and 2D fallback                                                                          | Screenshots of both modes, bundle check that Three.js is lazy      |
| 12  | Final pass: README, full test run, security checklist                                                     | Everything green                                                   |

**Tenant isolation tests (step 3)** cover, for every tenant table: tenant A cannot read, update or delete tenant B's rows; an insert carrying another tenant's id is rejected; no context returns zero rows; the app role is confirmed non-superuser and non-owner; a catalog test fails if any table with a `tenant_id` column lacks forced RLS (so a future table cannot ship unprotected); a composite FK blocks a cross-tenant reference; and a credential ciphertext moved to another tenant fails to decrypt.

---

## 8. Dependencies needing your approval

Not in your list. I will not add any of them without a yes.

| Package                                           | Used for                                                                       | If you say no                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------- |
| `zod`                                             | Validating env vars, form input, and vendor payloads at the connector boundary | Hand-written validators                |
| `tsx` (dev)                                       | Running the worker and seed script in TypeScript during development            | Build step before every run            |
| `pino`                                            | Structured logs with built-in redaction                                        | A small logger in `packages/core`      |
| `eslint` + `eslint-config-next`, `prettier` (dev) | Lint (including the brand-name rule) and formatting                            | No lint; the brand rule becomes a test |
| `pg` + `@prisma/adapter-pg`                       | Postgres driver, required by current Prisma                                    | Not optional with Prisma               |
| `server-only`                                     | Build error if server modules (crypto, db) are imported into client code       | Convention only                        |

Implied by your stack, listed so nothing is a surprise: shadcn/ui pulls in Radix primitives, `class-variance-authority`, `clsx`, `tailwind-merge` and `lucide-react`; BullMQ brings `ioredis`.

Deferred: a KMS SDK (for example `@aws-sdk/client-kms`), pending question 4.

---

## 9. Decisions

Taken at plan approval ("go with your recommendations").

| #   | Question                                                       | Decision                                                                                                                          |
| --- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Where the code lives                                           | `prajwalstark/Valtrexia`, branch `phase-1`, committed and pushed after each step                                                  |
| 2   | Dependencies in section 8                                      | All approved                                                                                                                      |
| 3   | Clerk keys                                                     | **Open.** Needed at step 6 to exercise live sign-in, MFA and the org webhook                                                      |
| 4   | Production KMS                                                 | **Open.** Phase 1 ships the `KeyProvider` interface and the local dev provider; the answer decides which prod provider is written |
| 5   | Does `warning` count as a completed backup for the missed rule | Yes. Default grace period is 2 hours per tenant                                                                                   |
| 6   | Who manages integrations                                       | Owners only (Clerk org admins). Technicians view and acknowledge                                                                  |
| 7   | 3D in Phase 1                                                  | Yes, as step 11                                                                                                                   |
| 8   | Notifications                                                  | Not in Phase 1; incidents are in-app only                                                                                         |

Changes made during the build:

- **TypeScript is pinned to 6.0**, not 7.0. `typescript-eslint` (which `eslint-config-next` depends on) supports TypeScript below 6.1 only.
- **The brand-name guard is a Vitest test**, not an ESLint rule. It needs no extra dependency and also covers CSS and MDX. Section 3 described it as a lint rule.
- **ESLint is set up in step 2**, alongside the Next.js app that brings its config.
- **shadcn/ui components are hand-written** in the standard shadcn layout (`components.json`, `components/ui`, `cn`). The shadcn registry was unreachable from the build session, so the CLI could not fetch them. The CLI works against this layout on a normal machine.
- **The typeface (Archivo) is self-hosted** with `next/font/local` instead of fetched from Google Fonts, so builds work offline and the app makes no third-party font request.
- **Row-level security is enabled, not forced.** Section 5 said "enabled and forced". `FORCE` only changes behaviour for the table owner, which the app never connects as, and it would stop the three security-definer functions (which run as the owner) from making their cross-tenant lookups unless the owner had `BYPASSRLS`, a superuser-only attribute that managed Postgres does not hand out. In its place, `Db.assertSafeRole()` refuses to run as a superuser, a role with `BYPASSRLS`, or a table owner. That also covers a superuser owner, which `FORCE` would not.
- **Policies apply to every role**, not only `valtrexia_app`, so any role added later is tenant-scoped by default.
- **The runtime role's name is fixed** (`valtrexia_app`) because the migrations grant to it by name. Only its password is configurable.
- **Prisma is pinned to 7.10.1.** The CLI's `latest` tag on npm points at an 8.0 release candidate.
- **User rows are deactivated, not deleted** (`deactivatedAt`), so audit entries and incident acknowledgements stay attributable.
- **The "ciphertext moved to another tenant fails to decrypt" test moves to step 4**, where the encryption code is written.
- **The missed-backup rule returns four verdicts**, not a yes/no: `missed`, `ok`, `suppressed` (archived, paused or muted) and `indeterminate` (sync never ran, is failing, or is more than three intervals old). An indeterminate verdict leaves an open incident untouched.
- **Client health has a fourth level, `none`**, for a client with no watched assets. Section 6 listed red, amber and green only.
- **`Asset.lastSuccessAt` means the last completed backup**, success or warning, because that is what the missed rule measures from.
- **`packages/core` has two entry points.** `@valtrexia/core` is pure and client-safe; `@valtrexia/core/server` holds the encryption and logging code, which need Node APIs.
- **The sync pipeline was built in step 5, not step 9.** The seed script needs to load mock data into the database, and that is the sync job. Writing it once, tested, was better than a throwaway seed. Step 9 now adds the scheduler, the queue and the incident engine around it.
- **The seed script lives in `apps/worker`**, not `packages/db/prisma`, so that `packages/db` does not depend on `packages/connectors`.
- **`normalizeStatus(raw)` takes a result's raw vendor payload.** A status often depends on more than one field (for Datto: the backup outcome and screenshot verification), so the sync job passes each result's `rawPayload` to the connector.
- **`Asset` gained `lastResultStatus`** (third migration). `currentStatus` can be `missed`, which is derived and hides what the vendor last reported.
- **The first sync reaches back 14 days**; the mock vendor keeps 30 days of history.
- **MFA is enforced twice.** Clerk's own session tasks (`setup-mfa`, `choose-organization`) are wired to `/mfa-required` and `/onboarding`, and the app independently refuses any session without a second factor. Clerk's API was read from the installed v7 package (Core 3), which differs from older documentation.
- **The webhook is a supplement, not a dependency.** Tenants and users are created at sign-in if missing, so local development needs no public webhook URL.
- **`organization.deleted` does not delete tenant data.** Removal is left as a deliberate operator action.
- **The web app loads the repository-root `.env`** from `next.config.ts`, so one file serves web, worker and database tooling.
- **Building the web app needs `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`.**
- **Datto's connection test was built in step 7**, ahead of the rest of the connector, so that "Test connection" on the integrations page is real. Listing clients, assets and results follows in step 8; until then a Datto integration can be saved but reports that syncing is not available yet.
- **Saving requires a passing connection test.** Keys Datto rejects, or cannot be reached to check, are not stored.
- **Replace keys and Disconnect were added** to the integrations page. The plan's scope line listed only adding credentials and testing; the approved decision 6 said owners add, replace and delete.
- **The connection-test rate limit is in memory**, per web instance. Section 6 did not specify where it lives. Redis is the place for it if a tighter bound is needed.
- **The Datto connector accepts more than one shape where the real one is unknown**: a bare array or a paged wrapper for lists, seconds, milliseconds or ISO for timestamps, and several spellings for each status. A wrong guess then degrades one record to `unknown` instead of failing a sync. The full list of unverified assumptions is in README.md under "Datto BCDR".
- **A Datto device with no client name and no organization becomes a client of its own**, named after the device, so nothing is silently dropped.
- **Datto results have `endedAt` equal to `startedAt`.** Datto reports the moment of a snapshot, not a duration.
- **Decrypted credentials are wrapped in a `Secret` type** that prints as `[redacted]`. Not in the original plan; it backs up the logger's redaction.
- **Navigation lists only pages that exist**: Dashboard and Integrations. The plan's route list is unchanged.

One environment note: Docker's daemon is not running in this cloud session. I will write and document `docker-compose.yml` for your machine, and verify here against the Postgres 16 and Redis 7 already installed in the container. The same tests run against either.
