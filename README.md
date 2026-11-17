# Valtrexia

**Unified Backup Intelligence** — _Every Backup. Every Client. Always in Sight._

A multi-tenant command center for Managed Service Providers: one place to monitor backups across vendors, catch failed and missed backups, and see every protected client asset.

Version 1 is **read-only**. It never starts, stops or changes a backup job.

## Status

Phase 1 is complete: all twelve steps in [PLAN.md](./PLAN.md) are built and tested. Phase 2 is under way, following [PLAN-PHASE-2.md](./PLAN-PHASE-2.md): steps 1 to 10 of 12 are done (continuous integration; handling of vendor data that stops arriving; the stale-backup rule; asset settings and mute; the incidents page, audit log and workspace settings; the notification outbox and signed webhooks; the notifications page and email channels, short of a real email provider; the Veeam Service Provider Console connector; the Kaseya UniView (Unitrends) connector; the AWS KMS key provider and key rotation). It is **not production-ready**. Three things have never been run against the real system they depend on, and several production requirements are not built.

**What works, verified here:**

- The database layer, tenant isolation, encryption, the missed-backup and incident rules, the sync pipeline and the worker, all tested against a real Postgres and Redis.
- The whole product end to end on the built-in demo vendor: the worker process syncing, statuses and incidents derived, the dashboard and client pages rendering that data.
- The setup steps below, from a clean machine: [CI](#continuous-integration) runs them on every push, including starting Postgres and Redis with Docker Compose.

**What has not been verified:**

| Area            | State                                                                                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clerk           | Never run against a live instance. Sign-in, MFA setup, organization creation and webhook delivery are untested end to end.                                       |
| Signed-in pages | Because of the above, the pages were checked through a temporary preview route with seeded data, not behind a real session.                                      |
| Datto BCDR      | The connector has never called Datto. Its response shapes are assumptions; see [Datto BCDR](#datto-bcdr) for the list to check.                                  |
| Veeam VSPC      | Built from Veeam's published OpenAPI specification, but never run against a real console. See [Veeam Service Provider Console](#veeam-service-provider-console). |
| Kaseya UniView  | Built from Kaseya's published OpenAPI specification, but never run against a real account. See [Kaseya UniView (Unitrends)](#kaseya-uniview-unitrends).          |
| 3D view         | Only run with software rendering, never on a graphics card.                                                                                                      |
| AWS KMS         | Built and tested against a stand-in KMS that behaves as AWS documents, never against AWS itself. See [Key management](#key-management).                          |

**What is not built:** sending email through a real provider (the provider is not chosen yet; see [Email](#email)), and the items listed in [SECURITY.md](./SECURITY.md).

### Before production

1. Run the app against a real Clerk instance and walk through sign-up, MFA, onboarding and the webhook.
2. Connect a real Datto account and reconcile the connector's assumptions with what Datto returns.
3. Create the AWS KMS key and IAM permissions, and set `VALTREXIA_KEY_PROVIDER=aws-kms` (see [Key management](#key-management)). The local key provider refuses to run in production.
4. Work through the open items in [SECURITY.md](./SECURITY.md).

## Repository layout

```
apps/
  worker/         Scheduler, sync queue, sync pipeline, incident engine and seed script.
  web/            Next.js app: sign-in, onboarding, dashboard, client pages, integrations.
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
- Docker with Compose, for local Postgres 16 and Redis 7 (or your own Postgres 16 and Redis 7; see [Database roles](#database-roles))

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

7. Check that everything is wired up. This runs the database and queue tests too, so Postgres and Redis must be up.

   ```bash
   pnpm check
   ```

8. Start the web app and open http://localhost:3000.

   ```bash
   pnpm dev
   ```

9. In a second terminal, start the worker. It syncs every connected vendor every 15 minutes, starting straight away.

   ```bash
   pnpm worker:dev
   ```

You will be asked to sign in, set up two-step verification and create a workspace. To attach the demo data to your workspace instead of a placeholder one, run the seed with your Clerk organization id: `SEED_CLERK_ORG_ID=org_... pnpm db:seed`.

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

## Dashboard

**Status strip.** Across the top of every page: how many watched assets have failed, been missed, warned or cannot be confirmed right now, how many are past their SLA, and when data was last synced. If an integration is failing to sync, or syncs have stopped altogether, it says so there.

**Integration problems.** When a vendor's data cannot be relied on, the dashboard says so above everything else, one line per integration: how long it has been failing and why, or since when nothing has arrived, and how many assets that leaves unconfirmed. A rejected key links straight to replacing it. If every integration has gone quiet at once, it says the background worker may not be running. See [When vendor data stops arriving](#when-vendor-data-stops-arriving).

**Dashboard.** Two thin bars summarize the fleet, clients by health and assets by status, each with its figures written out beside it. Below them is every client, worst first: health, a one-line description of what is wrong ("2 failed, 1 missed of 6 assets"), its assets as a small bar, and its open incident count.

**Fleet view.** At the top of the dashboard the fleet is drawn as a constellation: each sphere is a client, coloured by health and placed worst first from the centre, and the dots circling it are its assets, coloured by status. Clients that need action pulse slightly and are named; hovering any client shows its name and state, and selecting one opens it. A switch beside it changes between the 3D view and a 2D one.

The 2D view is a grid of tiles, one per client, worst first, with one square per asset. It is a complete view in its own right: every tile is a link, so it works with a keyboard and a screen reader, and it is rendered on the server, so it needs no JavaScript.

Which one is shown:

| Situation                                                                                           | View                                           |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| The system asks for reduced motion                                                                  | 2D always; the 3D option is disabled, with why |
| The browser has no WebGL 2                                                                          | 2D always; the 3D option is disabled, with why |
| The person has chosen a view                                                                        | That view                                      |
| No choice, and the device has under 4 cores or 4 GB, no graphics acceleration, or asks to save data | 2D, with 3D available to switch on             |
| Otherwise                                                                                           | 3D                                             |

- The choice is remembered in a cookie (it holds only `3d` or `2d`), so the server renders the right view first and the page does not jump on load.
- three.js and the scene are loaded only when the 3D view is shown: about 920 KB of JavaScript before compression that the 2D path never fetches.
- The scene stops rendering while it is scrolled out of view. If WebGL fails or its context is lost, the 2D view takes over and says so.
- It draws at most 120 clients and 28 assets per client, and says when it is leaving some out; the list below always has everything.
- The 3D view is an enhancement, never the only way to reach anything: the same clients, in the same order, are in the list directly below.

The decisions (which view, and where each client sits) are pure functions in `apps/web/lib/fleet-view.ts`.

**Client page.** The client's open incidents, then its assets worst first. Each asset shows its status, when it last backed up, and a strip of the last 14 days: one square per day in the workspace's time zone, showing that day's _worst_ result, so one failure is never hidden behind later successes. An empty square is a day with no backup. Opening an asset lists its individual backups with the vendor's own status, screenshot verification and any message. Assets that are archived, paused or muted are listed last and dimmed.

**Acknowledging an incident** records who is looking at it and when. It does not close the incident; only a completed backup does. Owners and technicians can both acknowledge.

### Asset settings

Opening an asset on the client page shows its settings beneath its backups. "Settings for all assets", above the list, applies the same to every asset of the client that is not archived.

| Setting                    | What it does                                                                                                    | Who                                                 |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Mute, with an end date     | Stops judging the asset until then: its open incidents close, and it leaves the health totals                   | Anyone, for up to 30 days. Owners, for up to a year |
| Mute until unmuted         | The same, with no end date. This is how to stop watching an asset for good                                      | Owners                                              |
| Unmute                     | Starts judging it again. Any problems reappear at the next sync                                                 | Anyone, whoever set the mute                        |
| Expected frequency and SLA | How often a backup is expected, and the longest the asset may go without one. One hour to one year (8760 hours) | Owners                                              |

- **Every mute needs a reason.** Who muted an asset, when, until when and why is shown on the asset while the mute stands.
- **The limits are enforced on the server**, whatever a form sends: muting hides problems, so a technician's reach is limited to 30 days, while unmuting can only bring problems back into view, so anyone may do it.
- **Every change is written to the audit log** in the same transaction, one entry per asset even when a change was made for a whole client, with the values before and after.
- **Frequency and SLA changes take effect at the next sync**, which re-judges the asset. A mute takes effect at once.
- **An asset's "paused" flag is not a setting.** It is the vendor's own and each sync overwrites it. A mute without an end date is the equivalent for someone here.
- An asset first seen from a vendor takes the vendor's schedule as its expected frequency when the vendor reports one. After that the value belongs to the MSP and syncs never overwrite it.

How status is shown:

- Every status has an icon and a word as well as a colour, and each day square has its own shape (cross, dot, ring, slash). Nothing depends on telling red from green.
- The status colours were checked with a palette validator: each pair is distinguishable under simulated red-green colour blindness and in normal vision, and each has at least 3:1 contrast against the background.
- Dates and times are shown in the workspace's time zone, set by an owner on the Settings page. See [Workspace settings](#workspace-settings).

The vendor's raw payload and anything about credentials are never sent to the browser; the queries name the columns they return. The logic is in `apps/web/lib/dashboard-core.ts` and is tested against Postgres.

## Incidents page

Every incident in the workspace, across clients, in three views:

| View            | Holds                                       | Order                      |
| --------------- | ------------------------------------------- | -------------------------- |
| Needs attention | Open, and nobody has acknowledged it        | Oldest first               |
| Acknowledged    | Open, and someone has said they are looking | Oldest first               |
| Closed          | Resolved                                    | Most recently closed first |

Each view shows its count, and the list can be narrowed to one client, one type of incident, or both; the counts follow the filter. An incident can be acknowledged from the list. The asset's name links to its client page.

Views, filters and pages are plain links and a plain form, so the page works without JavaScript and any view can be bookmarked or shared. Whatever a link says, a workspace sees only its own incidents: a client id from another workspace is treated as no filter at all. Lists are 50 to a page.

## Audit log

Owners can read every change made in the workspace on the Audit log page: when, who (or "System"), what in a sentence, the stored action name beneath it, and the IP address it came from. Entries can be narrowed to assets, incidents, integrations, people or workspace settings.

- **The log is written by the code that makes each change, in the same transaction**, so a change and its record succeed or fail together.
- **It cannot be edited or erased.** The application's database role may insert entries and read them, and nothing else; a test confirms an update and a delete are both refused by the database.
- **It holds no credentials.** Entries name what changed, never a key or a vendor payload.
- Something an entry is about that has since been removed is described as such ("an asset since removed") rather than left out. An action the page has no sentence for is shown by its stored name, so a new kind of entry is never hidden.
- Technicians cannot open it. The link is hidden from them, and the page refuses them where the log is read, not in the menu.

## Workspace settings

Two settings apply to the whole workspace. Anyone can see them on the Settings page; owners can change them, and each change is audited.

**Time zone.** Everything is stored in UTC. The time zone decides how dates and times are shown, and where one day ends and the next begins. That second part matters for an asset's 14-day strip: a backup at 23:30 in New York belongs to that evening, not to the next day in UTC. Days are counted on the calendar rather than in 24-hour steps, so a 23- or 25-hour day around a clock change is still one day. Changing the zone rewrites nothing.

No date in the app can be shown without a time zone: the formatting functions require one and have no default. The zone is always passed to the formatter explicitly, never taken from the server or the browser, so both render the same text.

**Grace period.** How long past its expected time a backup may be before it counts as missed, for every asset: 0 to 168 hours, 2 by default. Pages apply a new value at once; incidents follow from the next sync.

### Deleting a workspace

A workspace is deleted in two stages (decision 7), whether an owner asks for it on the Settings page (typing the workspace's name to confirm) or its organization is deleted in Clerk:

1. **Marked.** Syncing and notifications stop at the next scheduler tick, and every page shows when the data will be deleted. Nothing is removed yet. An owner can cancel, and syncing resumes. The Clerk organization and its members are untouched; an organization deleted in Clerk can no longer be signed in to, so only an operator could undo that one, by clearing the three deletion columns on the tenant.
2. **Deleted, 30 days later.** The maintenance job removes the tenant and, by cascade, every row it owns: clients, assets, results, incidents, encrypted credentials, notification channels and the audit log. The deletion is recorded in `tenant_deletions` (tenant id, Clerk organization id, name, reason, dates), a table the app's database role cannot read.

The database refuses a hold shorter than seven days, and only the `purge_due_tenants` function can delete a tenant; the app role cannot. Repeated requests never move the date. Requests and cancellations are audited. There is no export yet.

## Integrations

Owners connect vendors on the Integrations page. Technicians can see what is connected and its sync state, but cannot test, change or remove anything.

**Connecting Datto BCDR.** Enter a REST API public key and secret key from the Datto Partner Portal. "Test connection" checks the pair without saving it. "Save and connect" tests it again and only stores it if Datto accepts it, so a mistyped key is caught immediately rather than as a failed sync later. The test reads one device record and changes nothing.

**Connecting Veeam Service Provider Console.** Enter the console's address and an API key. The same "Test connection" and "Save and connect" apply. The address is checked before anything is sent to it; see [Veeam Service Provider Console](#veeam-service-provider-console).

**Connecting Kaseya UniView (Unitrends).** Enter the client ID and client secret of an API client created in the UniView Portal under API Access. The same "Test connection" and "Save and connect" apply; the test gets a token and reads one customer. A saved UniView integration shows the last four characters of its client ID.

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

The one request a connector makes outside that client is UniView's OAuth token request, a `POST` to a fixed address that only exchanges the client ID and secret for an access token; see [Kaseya UniView (Unitrends)](#kaseya-uniview-unitrends).

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

### Veeam Service Provider Console

Built from Veeam's published OpenAPI specification for the VSPC REST API (version 3.6.1, VSPC 9.1), and checked against the 3.5.1 specification (VSPC 8.1): every endpoint and field used exists in both. **It has never been run against a real console.** A stand-in console in `packages/connectors/src/vspc/fixtures.ts`, built to the specification, is what the tests use.

**Connecting.** Each MSP runs its own console, so the person connecting gives its address (the REST API listens on port 1280 by default) and an API key. Create the key in VSPC for a portal administrator or operator, with the REST API scope and **read-only access** (`isReadAccessOnly`): VSPC itself then refuses anything but reads, whatever our code did. The key is sent as `Authorization: Bearer`, with `x-client-version: 3.5.1` on every request, as Veeam asks.

**What is read.**

| Collection                                                        | Becomes                                                                                                                                      |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `organizations/companies`                                         | Clients. Companies being deleted are left out                                                                                                |
| `infrastructure/backupServers/jobs`                               | Which client each job belongs to (the one it is assigned to, else the one owning its backup server), whether it is enabled, and its schedule |
| `infrastructure/backupServers/jobs/backupVmJobs/objects`          | VMs, one asset per VM however many jobs protect it, and each job's latest session for it                                                     |
| `infrastructure/backupAgents`, `infrastructure/backupAgents/jobs` | Computers with a Veeam agent, and each agent job's latest session                                                                            |

Every request asks for only the fields it uses (VSPC's `select`). That also keeps fields we must not hold out of the response altogether: a company's record can carry its owner's password.

**History builds up from the day it is connected.** VSPC reports the latest session of each job, not a history. Each sync stores what the latest session says, keyed by when it started, so a session seen on several syncs is one result, and the next night's session is a new one. A first sync therefore cannot reach back fourteen days as Datto's can. Restore points, which VSPC does list, could fill in past successful backups later.

| VSPC says                           | Normalized |
| ----------------------------------- | ---------- |
| `Success`                           | `success`  |
| `Warning`                           | `warning`  |
| `Failed`                            | `failed`   |
| `Running`, `Starting`, `Stopping`   | `running`  |
| `Unknown`, `None`, or anything else | `unknown`  |

- **A machine is paused** when every job protecting it is disabled.
- **Expected frequency** is 24 hours for a job on a daily schedule. Other schedules leave it at the default: a periodic schedule's interval is only returned by VSPC 9.1.
- **Server errors** come back from VSPC as HTTP 520 and are retried. **Rate limiting** (429) gives its wait in the response body rather than a `Retry-After` header; the HTTP client reads either.

**Not covered yet:** replication, backup copy, file share, object storage, public cloud and Microsoft 365 jobs, and agents managed by a backup server rather than by the console. Their machines are not listed, so nothing is wrongly reported about them.

**To check against a real console:** that `select` is honoured on every collection; that an assigned job's `mappedOrganizationUid` is the company, and an unassigned one's `organizationUid` is the provider; that `infrastructure/backupAgents/jobs` lists Linux and Mac agent jobs as well as Windows (its description says Windows only, its schema says all three); that timestamps carry an offset; how a never-run session's times appear; and VSPC's default throttling limits.

### Kaseya UniView (Unitrends)

Built from Kaseya's published OpenAPI specification for the UniView public API (`public_api-v1`, served at `https://public-api.backup.net`) and its help page on API access. **It has never been run against a real UniView account.** A stand-in in `packages/connectors/src/uniview/fixtures.ts`, built to the specification, is what the tests use.

**Signing in.** UniView uses the OAuth 2.0 client credentials flow. The connector posts `grant_type=client_credentials` to `https://login.backup.net/connect/token`, with the client ID and secret as HTTP Basic auth, and sends the access token it gets back as `Authorization: Bearer` on every read. That token request is **the one request any connector makes that is not a `GET`**: it goes to one fixed address, carries one form field, follows no redirect, and changes nothing. The data itself is read only through the shared GET-only HTTP client. One token is fetched per sync and kept in memory for that sync; it is never stored or logged. Both hosts are fixed in the code; nothing a person types decides where these requests go.

**What is read.**

| Request                             | Becomes                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| `GET /v1/customers`                 | Clients                                                                        |
| `GET /v1/appliances`                | The name of the Unitrends appliance protecting each asset, shown as its device |
| `GET /v1/assets`                    | Assets, keyed by UniView's asset `key`                                         |
| `GET /v1/backups?start_time_from=…` | Results: one per backup, keyed by its type and start time                      |

Lists are paged with `page_number` and `page_size` (50, the documented default), in a fixed order, until a page comes back short. UniView keeps a history of backups and filters it by start time, so, as with Datto, a first sync reaches back 14 days.

| UniView says                | Normalized |
| --------------------------- | ---------- |
| `Successful`                | `success`  |
| `Warning`                   | `warning`  |
| `Failed`                    | `failed`   |
| `InProgress`                | `running`  |
| `Unknown`, or anything else | `unknown`  |

A failed replication to the backup's target does not change the backup's own status; it is noted in the result's message.

UniView does not report backup schedules, or whether an asset is paused or retired, so every UniView asset starts with the default expected frequency of 24 hours. Set the real one, or mute an asset, on its client page.

**To check against a real account:** that a token request with a bad secret is answered with HTTP 400 or 401 (either is treated as rejected keys); that `start_time_from` accepts an ISO 8601 timestamp in UTC; that a backup's `start_time` stays the same while it runs and after it completes (it is part of the result's key); that timestamps carry an offset (one without is read as UTC); and Kaseya's rate limits, which are not published. The connector keeps to two requests at a time and honours `429`.

### Demo vendor

`MockConnector` is a vendor that exists only in code. It produces a realistic fleet and a rolling backup history with no network access or API keys, so the product runs end to end without real credentials. It always has something to show: an asset on a failing streak, one that has gone silent (missed), one failing screenshot verification, one never backed up, one paused, one archived, one reporting a status the connector does not recognize, and one mid-backup.

Its history is a pure function of the seed and the clock, so it is stable: asking twice gives the same jobs, and asking later gives the same jobs plus the new ones.

The demo vendor is available only when `VALTREXIA_ENABLE_MOCK=true`, and never when `NODE_ENV=production`.

### Sync

`syncIntegration` (in `apps/worker`) pulls one integration's clients, assets and results and stores them. It never holds a database transaction open across a network call, writes everything in one transaction so a failed sync leaves the previous state intact, and is safe to run repeatedly. The first sync reaches back 14 days; later ones re-read 24 hours before the previous sync, so a backup that was still running is completed. A failure is recorded on the integration with a message written for a technician, never raw error text.

## Worker

`apps/worker` is a long-running process that keeps every integration in sync. It uses BullMQ on Redis.

- **Scheduler tick.** Once a minute (and once at startup) it asks the database which integrations are due: those whose last sync started more than 15 minutes ago, or never. It queues one sync job for each. The database is the source of truth; there is no per-integration schedule in Redis to drift when an integration is added, replaced or removed.
- **Sync jobs.** A pool runs them, five at a time by default. A job's id is its integration's id, so an integration is never synced twice at once, even with several worker processes.
- **Failures.** The HTTP layer retries transient vendor errors itself. A sync that still fails is recorded on the integration and tried again when it is next due, 15 minutes later, rather than in a tight loop. One failing integration does not hold up the others.
- **Several workers.** Any number of worker processes can run. The tick is a single schedule held in Redis, not one per process.
- **Shutdown.** On `SIGTERM` or `SIGINT` the worker stops taking new jobs, lets running syncs finish, then exits.
- **Safety at startup.** It refuses to start if connected to Postgres as a privileged role, or with invalid configuration, and says which setting is wrong without printing its value. In production it also refuses unencrypted connections: Postgres must use `sslmode=verify-full`, and Redis a `rediss://` URL with a password. The web app checks its database URL the same way.
- **Maintenance.** Every six hours (and at startup) one worker applies retention, across all tenants, in batches.

Finding what is due is the system's one cross-tenant read. It goes through a SQL function that returns ids only; each sync then runs inside its own tenant. A queued job carries two ids and nothing else: no names, no credentials.

| Setting                      | Default | Meaning                                                                                  |
| ---------------------------- | ------- | ---------------------------------------------------------------------------------------- |
| `SYNC_INTERVAL_MINUTES`      | 15      | How often each integration is synced. Also read by the web app; give both the same value |
| `SYNC_CONCURRENCY`           | 5       | Integrations synced at the same time by one process                                      |
| `SCHEDULER_TICK_SECONDS`     | 60      | How often the scheduler looks for due integrations                                       |
| `LOG_LEVEL`                  | info    | Worker log verbosity                                                                     |
| `RETENTION_RAW_PAYLOAD_DAYS` | 90      | Vendor payloads stored with results are emptied after this. Minimum 7                    |
| `RETENTION_RESULT_DAYS`      | 395     | Backup results are deleted after this (13 months). Minimum 30                            |
| `RETENTION_AUDIT_DAYS`       | 730     | Audit entries are deleted after this (24 months). Minimum 90                             |

**Retention** runs through one SQL function (`apply_retention`), because the runtime role cannot delete audit entries and must not be able to. The function refuses periods below the minimums above, whatever the configuration says. An emptied payload leaves the normalized result in place: its status, times and message stay; only the vendor's own record goes.

**No queue-level retries for syncs** (decision 9). A failed sync is tried again at its next turn, 15 minutes later. Retrying sooner mostly adds load to a vendor that is already struggling, and the HTTP client already retries transient errors and honours rate limits within a sync.

### Incidents

An incident is a problem with one asset that stays open until it resolves, so a technician sees one item per problem rather than one per failed attempt. Incidents are opened and closed inside the same transaction as the statuses they follow from, by `planIncidents` in `packages/core`.

| Type     | Opens when                                                        | Closes when                             |
| -------- | ----------------------------------------------------------------- | --------------------------------------- |
| `failed` | The latest result failed                                          | A backup completes (success or warning) |
| `missed` | The missed-backup rule says one was missed                        | A backup is back inside its window      |
| `stale`  | The asset has gone longer than its SLA without a completed backup | A backup completes                      |
| any      |                                                                   | The asset is archived, paused or muted  |

- A `failed` incident stays open while a retry is running or its outcome is unreadable.
- A failed sync opens and closes nothing: with the vendor unreachable, neither a missed backup nor a recovery can be known.
- An asset whose backups fail for days collects all three, each as its own line is crossed: the latest attempt failed, none completed in time, and it has now gone longer than its SLA without one. A completed backup closes all three together.
- At most one incident of each type is open per asset, enforced by a database index.
- Who acknowledged an incident is kept after it closes. A new failure after a closure is a new incident.

Opened and closed incidents are also sent to notification channels: see [Notifications](#notifications).

## Notifications

When incidents open or close, or an integration becomes unhealthy or recovers, the people who asked are told, by webhook or by email.

**The Notifications page** lists every channel, where it sends, what it hears about, and how its last five messages fared: sent, waiting, retrying (with when and why), or not delivered. Owners add channels, send a test message, turn a channel off and on, and delete it; technicians see the same list without the controls. Every change is audited. Changing what a channel hears about means deleting it and adding it again; there is no edit form yet.

**What is sent, and to whom.** A channel chooses which incident types it hears about (failed, missed, stale), whether it hears about openings, closings or both, and whether it hears about integration health.

- **One message per sync, not per asset.** A sync that opens forty incidents because a client's appliance died sends each channel one message listing all forty. Over 100 changes are split into messages of 100.
- **Never the same thing twice.** Each channel is told about each event of each incident once. The sync checks before queuing, and a unique key on the delivery record enforces it whatever a retry or a crash does.
- **Nothing about decisions.** An incident closed because someone muted the asset, or the vendor paused or archived it, is not reported. A brief sync failure that clears by itself is not reported either: an integration is reported once when it becomes unhealthy (four failures in a row, or a rejected key), and once when it recovers.
- **Names and times, nothing else.** A message names the workspace, client, asset, incident type and times. It never contains credentials or a vendor's raw payload.

**How it is sent.** Messages are written to an outbox table in the same transaction as the change they report, so a message exists exactly when its change does. A worker job, every 30 seconds by default, finds the messages that are due and sends them.

| Situation                                      | What happens                                                                                        |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| The endpoint answers 2xx                       | Sent                                                                                                |
| Any other answer, a timeout, no connection     | Tried again after 1, 5, 15, 30, 60, 120 and 240 minutes, then given up: 8 attempts in about 8 hours |
| The endpoint answers 410 Gone                  | Given up at once                                                                                    |
| The destination is not allowed (see below)     | Given up at once                                                                                    |
| The channel was turned off after it was queued | Not sent                                                                                            |

Each attempt first claims the message for two minutes, so two workers never send it at once. If a worker dies after sending but before recording it, the message is sent again when the claim runs out. That is the one way a receiver can get a message twice, and every attempt at a message carries the same `webhook-id`, so a receiver can recognize the repeat. Exactly-once delivery is not something any sender can promise.

### Email

An email channel sends one email per message to up to 20 addresses, all on the same email. It is written in plain text and in HTML, saying the same thing, with every date in the workspace's time zone: which assets need attention or have recovered, grouped by client, with when each last had a good backup. Names from vendors and people are escaped in the HTML, and line breaks are removed from the subject, so a client called `Acme\r\nBcc: …` cannot add a header.

**No email provider is connected yet** ([decision 1](./PLAN-PHASE-2.md)). Sending goes through an `EmailSender` interface, and each provider is one small implementation of it; everything else (rendering, the outbox, retries) is built and tested. Until then:

| `EMAIL_PROVIDER` | What happens                                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------------------- |
| empty (default)  | Email channels cannot be added; the page says email is not set up. Anything queued for one is not delivered     |
| `log`            | Development only: each email is logged by subject and number of recipients, and not sent. Refused in production |

Set the same value for the web app and the worker. A provider failure is retried on the usual schedule when it may pass, and given up on when it will not.

### Webhooks

A webhook channel `POST`s JSON to an https URL. Requests are signed following the [Standard Webhooks](https://www.standardwebhooks.com) specification, so a receiver can verify them with an existing library:

| Header              | Value                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `webhook-id`        | The message's id, the same on every retry                                                |
| `webhook-timestamp` | When this attempt was sent, in seconds                                                   |
| `webhook-signature` | `v1,` and the base64 HMAC-SHA256 of `<id>.<timestamp>.<body>` under the channel's secret |

A receiver should check the signature and refuse a timestamp more than five minutes from its own clock, so a captured request cannot be replayed. The signing secret is shown once, when the channel is created, and stored encrypted like vendor credentials. So is the URL, because webhook URLs often carry a token in the path. Nobody can read either back afterwards; the interface and the audit log show only the host.

The body is `{ "type", "version", "timestamp", "data" }`, with `type` one of `incidents.changed`, `integration.unhealthy`, `integration.recovered` or `test`.

### Sending to addresses a tenant typed in

The server, not the tenant, makes the connection to a webhook URL. Without care, a tenant could point it at the server's own network: `localhost`, a database, or a cloud metadata address. So every destination is checked when the channel is saved, and again at every send:

- https only, no user name or password in the URL, and port 443 or 1024 and above;
- the host name is resolved, and refused if any address it resolves to is loopback, private, link-local (including `169.254.169.254`), carrier-grade NAT, multicast, reserved, or an IPv6 form of any of those;
- the connection is made to the addresses that were checked, from the same DNS answer, so a second answer cannot swap the target in between;
- redirects are never followed, a request may take 10 seconds, and only a bounded amount of any response is read. The response body is never stored, logged or shown.

For testing a receiver on your own machine, `VALTREXIA_ALLOW_PRIVATE_DESTINATIONS=true` allows http and private addresses. It is ignored when `NODE_ENV=production`.

## How backup health is decided

The logic is pure functions in `packages/core`, with no database or network access, so it is tested exhaustively.

**Statuses.** Every vendor result is normalized to one of `success`, `warning`, `failed`, `missed`, `running` or `unknown`. A warning still counts as a completed backup: one that succeeded but failed screenshot verification produced a restore point.

**Missed backups** (`evaluateMissedBackup`). An asset is missed when its last completed backup, or its discovery if it has never had one, is more than its expected frequency plus the tenant's grace period ago. The rule returns one of five verdicts:

| Verdict         | When                                                                                   | Effect on a missed-backup incident |
| --------------- | -------------------------------------------------------------------------------------- | ---------------------------------- |
| `missed`        | No completed backup inside the window                                                  | Open one                           |
| `ok`            | A completed backup inside the window                                                   | Close it                           |
| `suppressed`    | The asset is archived, paused or muted                                                 | Close it                           |
| `indeterminate` | The vendor data is out of date, but the asset's last backup is still inside its window | Leave it as it is                  |
| `unconfirmed`   | The vendor data is out of date, and the window has closed since                        | Leave it as it is                  |

Vendor data is out of date when the integration has never synced, its sync is failing, or its last successful sync is more than three sync intervals old (45 minutes by default). The last two verdicts exist so that a vendor outage does not raise a missed-backup incident on every asset that vendor protects.

**Stale backups** (`evaluateSla`). A different question from the missed-backup rule's. That one asks whether the latest expected backup happened. This one asks how long the asset has now been without any good backup, whatever the reason: three days of nightly failures count the same as three days of silence. Each asset has an SLA in hours (72 by default). When its last completed backup, or its discovery if it has never had one, is longer ago than that, a `stale` incident opens and the asset is marked as past its SLA, from the moment the SLA was crossed.

Two rules keep it from misfiring:

- **The SLA applied is never shorter than the asset's own backup window** (expected frequency plus grace). An asset backed up weekly cannot honour a 72-hour SLA, and would otherwise be reported stale every week while doing exactly what it is scheduled to do. So a stale backup is always also a missed one: stale is the escalation of missed and never fires before it. The client page shows the SLA that was applied.
- **It is never judged on out-of-date data**, and not at all for an asset that is archived, paused or muted, exactly as with the missed-backup rule.

"Stale" is an incident type and a marker on the asset, not a seventh status. An asset past its SLA is shown as `failed` or `missed`, with how long it has been past its SLA beside it.

### When vendor data stops arriving

A stored status is only as fresh as the sync that wrote it. Two things can stop syncs: a vendor problem (an outage, a revoked key), which records an error, and the worker itself stopping, which records nothing at all. Both are handled the same way, and neither can leave an asset looking backed up indefinitely.

**Assets.** When an asset's verdict is `unconfirmed`, it is shown as `unknown`, with "No vendor data since …" beside it, and it stops counting as backed up in every total. An asset last seen failed, missed or with a warning keeps that status: not being able to look never makes an asset look better than it last was. No incident is opened, because nothing was seen to go wrong, and none is closed.

This is worked out each time a page is read (`statusInView`), from the stored status, the asset's window and the integration's last successful sync. It is deliberately not written by a background job: the worker being down is one of the cases it has to catch.

**Integrations** (`assessIntegrationHealth`). Each sync failure records how many have happened in a row, when the run began, and what kind of failure it was.

| State       | When                                                                                                                                         |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `waiting`   | Connected, first sync not finished                                                                                                           |
| `healthy`   | The last sync succeeded recently                                                                                                             |
| `retrying`  | One to three failures in a row of a kind that can clear by itself                                                                            |
| `unhealthy` | Four failures in a row (an hour by default), or one failure the vendor will repeat: a rejected key, or saved credentials that cannot be read |
| `stalled`   | Nothing is failing, but no sync has finished for more than three intervals                                                                   |

A successful sync, or replacing the credentials, ends a run of failures. The worker logs a warning when an integration becomes unhealthy and a line when it recovers. Each transition is also sent to notification channels that ask for it: see [Notifications](#notifications).

The web app and the worker must be given the same `SYNC_INTERVAL_MINUTES`, since the web app uses it to judge freshness. Each refuses a value that is not a whole number from 1 to 1440, and a test checks that they accept and refuse the same values.

**Client health** (`summarizeClientHealth`). Red if any watched asset has failed or missed; amber for a warning, a status that is unknown or cannot be confirmed, or vendor data that is out of date; green otherwise; and `none` when a client has no watched assets. Muted, paused and archived assets are left out. Clients sort worst first, then by number of affected assets, then by name.

## Credentials and logs

Vendor credentials are encrypted before they reach the database, with envelope encryption (`@valtrexia/core/server`):

- Each credential set gets its own random data key (AES-256-GCM). The data key is wrapped by a key-encryption key and stored beside the ciphertext.
- Both layers are bound to the tenant id and integration id. A ciphertext copied to another tenant's row, or another integration, will not decrypt.
- The key-encryption key comes from a `KeyProvider`: AWS KMS in production, `VALTREXIA_LOCAL_KEK` in development. The local provider refuses to run when `NODE_ENV=production`. See [Key management](#key-management).
- Decrypted values come back wrapped in `Secret`, which prints as `[redacted]` if logged, serialized or inspected. The value is only reachable through `.expose()`.

### Key management

**AWS KMS.** Set `VALTREXIA_KEY_PROVIDER=aws-kms` and `VALTREXIA_KMS_KEY_ID` to the ARN of a symmetric KMS key, or of an alias for it. The web app and the worker both need it. AWS credentials come from the AWS SDK's usual sources, normally the IAM role the app runs under; never put AWS keys in this repository.

- Each record's data key is wrapped with KMS `Encrypt` and unwrapped with `Decrypt`, naming the key, so KMS refuses a wrapped key made with any other key.
- The tenant, record and purpose go to KMS as encryption context (`valtrexia: v1|purpose|tenant|record`), so KMS itself refuses a wrapped key copied onto another tenant's or record's row. That context appears in CloudTrail, which shows which record each call was for. It holds ids, never values.
- Data keys are not cached: each decryption is one KMS call, so a revoked permission takes effect at once. In practice that is one call per integration per sync and one per webhook sent.
- When KMS cannot answer (throttling, an outage, a disabled key, a missing permission), the error says the key service is unavailable. Syncs retry on the next run and webhooks on their usual schedule. A tenant is never told to re-enter credentials because of it. Only a value that does not decrypt is reported as unreadable.

The IAM role needs this, and nothing else from KMS:

```json
{
  "Effect": "Allow",
  "Action": ["kms:Encrypt", "kms:Decrypt"],
  "Resource": "arn:aws:kms:REGION:ACCOUNT:key/KEY-ID"
}
```

During a rotation, also allow `kms:Decrypt` on the old key. Enable KMS automatic key rotation on the key: AWS then rotates its key material yearly under the same ARN, old records keep decrypting, and nothing here has to run.

**Rotating the key.** To move to a different key (another KMS key, or from a local key to KMS outside production), use `pnpm keys:rotate`. It re-wraps each record's data key under the current key, in every tenant, one record at a time. The values themselves are not re-encrypted, and no value is printed or logged.

1. Configure the new key as current, keeping the old one readable: for KMS, point `VALTREXIA_KMS_KEY_ID` (or its alias) at the new key and leave `kms:Decrypt` on the old one; for local keys, set `VALTREXIA_LOCAL_KEK` to the new key and `VALTREXIA_PREVIOUS_LOCAL_KEKS` to the old one. Deploy the web app and worker with that configuration.
2. Run `pnpm keys:rotate --dry-run` to see how many records are under which key, then `pnpm keys:rotate`.
3. It is safe while the app is running. A record replaced while it is being moved is left alone, because its new value is already under the new key. The command is resumable: if KMS stops answering it stops, and running it again carries on. It exits non-zero while anything is left.
4. A record no configured key can read is listed by id and left in place; its owner has to re-enter it. Everything else is still moved.
5. When it reports that every record is under the current key, remove the old key from the configuration and revoke access to it.

Each record moved is written to its tenant's audit log, as the system.

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

| Command            | What it does                                                |
| ------------------ | ----------------------------------------------------------- |
| `pnpm dev`         | Runs the web app with reload                                |
| `pnpm build`       | Production build of the web app                             |
| `pnpm worker:dev`  | Runs the worker with reload                                 |
| `pnpm typecheck`   | Type-checks every package                                   |
| `pnpm lint`        | Lints the repository with ESLint                            |
| `pnpm test`        | Runs every test once (needs Postgres)                       |
| `pnpm test:unit`   | Runs only the tests that need no services                   |
| `pnpm test:db`     | Runs only the database tests                                |
| `pnpm test:watch`  | Runs Vitest in watch mode                                   |
| `pnpm format`      | Formats the repository with Prettier                        |
| `pnpm check`       | Type check, lint, tests and format check together           |
| `pnpm infra:up`    | Starts local Postgres and Redis                             |
| `pnpm infra:down`  | Stops them (data is kept)                                   |
| `pnpm db:migrate`  | Applies pending migrations as the owner role                |
| `pnpm db:check`    | Fails if the migrated database and the Prisma schema differ |
| `pnpm db:generate` | Regenerates the Prisma client                               |
| `pnpm db:seed`     | Loads demo data through the real sync pipeline              |

## Continuous integration

`.github/workflows/ci.yml` runs on every push, on pull requests from forks, and once a week. It needs no secrets.

| Job              | What it does                                                                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Check and build  | The [setup](#setup) steps on a clean runner: install, `.env` from the example, `pnpm infra:up`, `pnpm db:migrate`, `pnpm db:check`, type check, lint, format check, all tests, seed, build |
| Dependency audit | `pnpm audit --prod`. Separate, so a new advisory is not mistaken for a broken build                                                                                                        |

The weekly run exists because two things can break without a commit: a new advisory against a dependency, and a container image or action changing underneath the workflow.

A test (`packages/core/src/ci-workflow.test.ts`) fails if a workflow uses an action that is not pinned to a commit, asks for more than read access to the repository, refers to a secret, or stops running a step of `pnpm check`.

The build step uses placeholder Clerk keys that identify no Clerk instance. CI therefore proves the app builds, not that sign-in works.

## Conventions

- **Branding lives in one file.** The product name, positioning and tagline are defined in `packages/core/src/brand.ts`. Import `brand` from `@valtrexia/core`; a test fails if any of them is hard-coded elsewhere under `apps/` or `packages/`.
- **One typeface, self-hosted.** Archivo is bundled in `apps/web/app/fonts` under the SIL Open Font License, so builds make no request to a font service. Headings use its wide setting (`font-wide`).
- **Status colours mean status.** Red, amber and green are reserved for backup health. The brand colour is iris; design tokens are in `apps/web/app/globals.css`.
- **UI components follow shadcn/ui.** They live in `apps/web/components/ui`; add more with `pnpm dlx shadcn@latest add <name>` from `apps/web`.
- **Every page and server action checks the session first.** `requireTenant()` or `requireOwner()` must be the first thing a tenant page or a server action awaits; a test reads the source and fails otherwise.
- **No secrets in the repository.** Only `.env.example` is committed, and it contains local-development placeholders.
- **Never log credentials or raw vendor payloads.**
- **Ask before adding a dependency** that is not already in the plan.
