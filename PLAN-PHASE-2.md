# Phase 2 plan

Status: **approved** ("go with your recommendations"). Branch: `phase-2`, cut from `main` after the Phase 1 merge. Progress is recorded in section 10.

No scope was given for Phase 2, so this plan proposed one, and it was approved as written. Section 8 records the decisions: the recommendations stand, and four still need an answer from the owner before the step that depends on them.

Phase 1's plan stays in `PLAN.md` as the record of what was built.

---

## 1. Where Phase 1 left things

Phase 1 pulls Datto results every 15 minutes, normalizes them, raises `failed` and `missed` incidents, and shows them in the dashboard. Four things stop it from being something an MSP could rely on:

1. **Nobody is told.** Incidents exist only in the app. The brief says "detect failed/missed/stale backups, and alert"; the alert half is missing.
2. **A broken integration goes quiet.** The missed-backup rule runs only inside a successful sync (`apps/worker/src/sync/sync-integration.ts`). If a vendor API is down or a key is revoked, the sync fails, no rule runs, and assets keep their last status. An asset that was green two days ago is still shown green, although nothing has been heard about it since. The integrations page shows the error, but nothing else does. This is the most serious gap, because the failure is silent.
3. **One vendor.** Unitrends and VSPC are named in the brief as v1 vendors and are not built.
4. **It cannot go to production.** No KMS key provider, no CI, no retention, no offboarding. `SECURITY.md` lists eleven open items.

Also not built: the stale/SLA rule (`IncidentType.stale` is reserved in the schema), any way to change an asset's expected frequency, SLA or mute from the UI, an incidents list across clients, and time zones other than UTC.

Never verified against a live service: Clerk, Datto, Docker Compose, and the 3D view on a real GPU. These still need your keys or your machine.

## 2. What Phase 2 delivers

Four groups, in this order. Each group is useful if the phase stops after it.

| Group                      | Outcome                                                                                                                                                              |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Complete the monitoring | A failing integration can no longer leave assets looking healthy. Stale backups are detected. Technicians can tune and mute assets and work a single incident queue. |
| B. Alerting                | Incidents and integration failures reach people by email and webhook, batched so one outage is one message, never repeated.                                          |
| C. Vendors                 | Veeam VSPC connector. Kaseya UniView connector if its API can be pinned down (section 6).                                                                            |
| D. Production readiness    | KMS key provider and key rotation, CI, retention, tenant offboarding, a full Content-Security-Policy, shared rate limiting.                                          |

**Still out of scope after Phase 2:** PSA ticketing (ConnectWise, Autotask, HaloPSA), scheduled or PDF client reports, billing, SSO beyond what Clerk provides, per-user notification preferences, a mobile layout pass, and any write action against a vendor. v1 remains read-only.

## 3. Task order

Every step ends with `pnpm check` (type check, lint, format, all tests) and a short report of what changed, as in Phase 1. Each step is committed and pushed to `phase-2`.

| #   | Step                                                                                                                                                                                               | Needs from you                | Verified by                                                                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1   | CI: GitHub Actions running type check, lint, format, tests (Postgres and Redis services), build and `pnpm audit` on every push and pull request                                                    | Nothing                       | A green run on `phase-2`, and a deliberately broken commit that turns it red                                                        |
| 2   | Blind-spot sweep: an asset whose integration cannot sync stops showing its last status and becomes `unknown`. Integration health: consecutive failures and "failing since", shown on the dashboard | Decision 11                   | Test: sync fails, a green asset becomes `unknown` after its window and leaves the healthy count. Test: recovery restores evaluation |
| 3   | Stale/SLA rule and `stale` incidents                                                                                                                                                               | Decision 3                    | Rule tests alongside the missed-backup tests; incident tests                                                                        |
| 4   | Asset settings: expected frequency, SLA hours, mute with an end time and reason, pause. Per asset and for all of a client's assets. Audit entry for every change                                   | Decision 4                    | Action tests including tenant isolation and role checks; screenshots                                                                |
| 5   | Incidents page across clients (open, acknowledged, closed; filter by client and type). Audit log page for owners. Workspace settings: time zone, grace hours                                       | Nothing                       | Query tests on real Postgres; time zone tests around midnight and daylight-saving changes; screenshots                              |
| 6   | Notification foundation: channels, the outbox, batching and de-duplication, delivery worker with retries, and the signed webhook channel                                                           | Nothing                       | Tests: one outage produces one message; a retry never sends twice; a muted asset sends nothing; SSRF tests                          |
| 7   | Email channel, notification settings page, "Send test"                                                                                                                                             | Decision 1                    | Tests against a fake provider. A real email only once you add a provider key                                                        |
| 8   | Veeam VSPC connector, with a server address supplied by the tenant                                                                                                                                 | Decision 5, and docs (sec. 6) | Normalizer and pagination tests on fixtures; GET-only assertion; SSRF tests. Unverified until a real server                         |
| 9   | Kaseya UniView connector                                                                                                                                                                           | Decision 6                    | As step 8                                                                                                                           |
| 10  | KMS key provider and a key rotation command                                                                                                                                                        | Decision 2                    | Provider tests against a fake KMS; rotation test that old records still decrypt. Real KMS needs your cloud                          |
| 11  | Hardening: CSP with nonces, shared rate limiting, TLS required for Postgres and Redis in production, retention job, tenant offboarding, queue-level sync retries                                   | Decisions 7 and 8             | A test for each; CSP checked in a browser with no violations on every page                                                          |
| 12  | Final pass: README, `SECURITY.md`, fresh-clone run of the setup steps, full test run                                                                                                               | Nothing                       | Everything green                                                                                                                    |

**Floating task: live verification.** Whenever you add Clerk keys, Datto keys or a VSPC server, I stop the current step, verify against the real service, and fix what differs. It is not tied to a step number because it depends on you.

If you want a smaller phase, the natural cuts are after step 7 (monitoring and alerting complete, one vendor) or to drop step 9.

## 4. Designs that need more than a line

### 4.1 Blind spots and integration health (step 2)

Today the sync does three things in one transaction: store results, evaluate rules, plan incidents. When the sync fails, none of that runs, and the missed-backup rule deliberately returns `indeterminate` for a failing integration rather than raise incidents on old data. That part is right: we cannot say a backup was missed when we could not look. What is wrong is that the asset goes on showing its last known status.

Step 2 adds a sweep job, every 15 minutes, that looks at assets whose integration has not synced successfully:

- Once an asset has gone unseen for longer than its expected frequency plus grace, its status becomes `unknown`, with the reason "no data from the vendor since …". It stops counting as healthy in the client and fleet roll-ups. It is not marked `missed`, because that would be a claim we cannot support (decision 11).
- Incidents that were already open stay open, as now. No new asset incidents are raised while blind.
- `Integration` gains `consecutiveFailures` and `failingSince`. An integration counts as unhealthy after 4 consecutive failed syncs (one hour), or immediately on an authentication failure, which will not fix itself. Unhealthy integrations are shown on the dashboard, not only on the integrations page, and from step 6 they send one notification when they become unhealthy and one when they recover.
- When the integration recovers, the next sync evaluates every asset on fresh data, exactly as today.

The sweep reads across tenants the same way the scheduler does: a narrow `SECURITY DEFINER` function that returns only ids, then `withTenant` per tenant. No new bypass of row-level security. The rule itself stays a pure function in `packages/core` with one new verdict.

### 4.2 Stale/SLA rule (step 3)

The status enum is fixed by the brief (`success | warning | failed | missed | running | unknown`), so "stale" is an incident type and a flag on the asset, not a seventh status.

- **Missed** answers "did the last expected backup happen?" (expected frequency plus grace).
- **Stale** answers "how long has this asset gone without a good backup?" It opens when the last completed backup is older than `slaHours`, whether the attempts since then failed or never ran. An asset that fails every night for three days is `failed` on the dashboard from the first night; it becomes `stale` when the SLA is crossed. That is the escalation.
- An asset with no completed backup ever is measured from when it was first seen.
- Muted and paused assets are skipped, as with the missed rule.
- Like the missed rule, it is evaluated only on fresh data. While an integration is blind the asset is `unknown` (4.1), and the stale check runs on the first successful sync after recovery.
- A `stale` incident closes on the next completed backup. It can be open at the same time as a `failed` or `missed` incident on the same asset; the existing "one open incident per asset and type" index already allows that.

### 4.3 Notifications (steps 6 and 7)

**Schema, all tenant-scoped with the same row-level security policies as every other table:**

| Table                  | Holds                                                                                                                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NotificationChannel`  | Type (`email`, `webhook`), name, enabled, which events it wants (incident types; opened and closed; integration unhealthy and recovered), and its settings. Secrets in it are envelope-encrypted    |
| `NotificationBatch`    | One message to one channel: the incidents or integration event it covers, status, attempt count, next attempt time, a sanitized last error                                                          |
| `NotificationDelivery` | One row per (incident, event, channel), unique. This is the de-duplication guarantee: the database refuses a second notification for the same thing, whatever the worker does on a retry or a crash |

**Flow.** When a sync opens or closes incidents, or the sweep marks an integration unhealthy or recovered, it writes the delivery rows and one batch per channel in the same transaction as the incidents themselves. A separate worker job sends pending batches. If the process dies between the two, the batch is still there and is sent on the next pass; if it dies after sending but before marking the batch sent, the message can be delivered twice, so every message carries a stable id that a receiver can de-duplicate on. I will say that in the docs rather than claim exactly-once delivery.

**Batching.** One sync that opens forty incidents because a client's appliance died produces one email listing forty assets grouped by client, not forty emails.

**What does not notify:** muted or paused assets; incidents that open and close within the same run; the demo vendor, unless you want it to for testing.

**Webhook channel.** `POST` of a JSON body to an HTTPS URL the owner supplies, signed with HMAC-SHA256 over the timestamp and body using a per-channel secret that is shown once at creation. Because the URL is user-supplied, it goes through the outbound guard in 4.4.

**Email channel.** A list of recipient addresses per channel. Sending goes through an `EmailSender` interface with one real implementation (decision 1) and a development sender that writes to the log. Plain text plus simple HTML, brand name and tagline from the brand config.

**Content.** A notification names the client, asset, incident type, and when the last good backup was. It never contains credentials or raw vendor payloads.

**Read-only stays true.** The vendor HTTP client stays GET-only, and its test stays. Notification sending is a separate client in a separate module that can only reach notification destinations, never a vendor.

### 4.4 Outbound guard for user-supplied addresses (steps 6 and 8)

Webhook URLs and the VSPC server address are both typed in by a tenant, and the server then connects to them. Without care, that lets a tenant point the server at its own internal network or a cloud metadata address. One shared guard, used by both:

- HTTPS only, valid certificate required, no redirects followed.
- The hostname is resolved once; the request is refused if any resolved address is loopback, private, link-local, carrier-grade NAT, multicast, or an IPv4-mapped form of those; and the connection is made to the address that was checked, so a second DNS answer cannot swap the target.
- Timeouts, a response size cap, and a per-tenant rate limit on tests.
- Error messages shown to the user say what failed without echoing response bodies.

This is written with Node's built-in `https` module, so it needs no new dependency. An allowlist escape for local development exists only when `NODE_ENV` is not `production`, the same pattern as the mock connector.

### 4.5 Time zones (step 5)

`Tenant.timeZone` (an IANA name, default `UTC`). All timestamps stay stored in UTC. Display, the 14-day strip's day boundaries, and "today" in notifications use the workspace time zone, through the platform's built-in `Intl` support. Per-user time zones are left for later.

### 4.6 KMS and key rotation (step 10)

Phase 1 left the `KeyProvider` interface and stores a `keyId` with every encrypted record, so this step adds a provider without touching the encryption format.

- One provider for the cloud you choose. It wraps and unwraps data keys with the KMS key and passes the same context (purpose, tenant, record) as authenticated data, so a wrapped key copied onto another tenant's record does not unwrap.
- A rotation command that re-wraps each record's data key under the new key, in batches, resumable, and safe to run while the app is serving. Credentials themselves are not re-encrypted and are never held in plain text longer than one record at a time.
- Notification channel secrets use the same mechanism with a different purpose label.

### 4.7 Retention and offboarding (step 11)

- **Retention.** A daily job. Raw vendor payloads are cleared after 90 days, backup results deleted after 13 months, audit entries kept for 24 months. These are defaults I am proposing, set per deployment rather than per tenant; change the numbers in decision 8.
- **Offboarding.** When an organization is deleted in Clerk, the tenant is marked for deletion, syncing and notifications stop at once, and its data is deleted after a 30-day hold. An owner can also request deletion in workspace settings. The deletion is one cascade from `tenants`, which the schema already supports, and it is logged outside the tenant's own audit log, since that log is deleted with it.

## 5. Schema changes

All additive. Each ships as its own migration in the step that needs it.

| Step | Change                                                                                                                 |
| ---- | ---------------------------------------------------------------------------------------------------------------------- |
| 2    | `Integration.consecutiveFailures`, `Integration.failingSince`; a definer function listing integrations due for a sweep |
| 3    | `Asset.staleSince`                                                                                                     |
| 4    | `Asset.mutedReason`, `Asset.mutedByUserId`                                                                             |
| 5    | `Tenant.timeZone`; an index on incidents for the queue's sort order                                                    |
| 6    | `NotificationChannel`, `NotificationBatch`, `NotificationDelivery`, with policies; a function for pending batches      |
| 8    | `Integration.baseUrl` (not a secret; shown in the UI)                                                                  |
| 11   | `Tenant.deletionRequestedAt`, `Tenant.deleteAfter`; a small non-tenant table recording completed deletions             |

Every new tenant table is added to the tenant isolation test in the same step.

## 6. Vendor API uncertainty

The documentation sites for Veeam and Kaseya are blocked from this build session (the network proxy refuses them), so I have not been able to read either API reference. What follows is from memory and must be treated as unverified.

**Veeam VSPC.** I believe it has a REST API (v3) served by the provider's own VSPC server, commonly on port 1280, with bearer authentication by API key, company and job endpoints, and `limit`/`offset` paging. I am fairly confident in that outline and not confident in exact paths, field names, status values, or which endpoints return per-job session history rather than only the latest state. Because each MSP runs its own server, the tenant supplies the address (4.4).

**Kaseya UniView (Unitrends).** I am much less sure. Unitrends appliances have their own REST API, but appliances are usually not reachable from the internet. Whether the UniView portal has a documented public API with per-asset backup history, and how it authenticates, I do not know well enough to build on.

Same approach as Datto, as your brief requires: say so, isolate it behind the connector interface, build on fixtures, list every assumption in the README, and mark the connector unverified until real keys exist. To do even that well, I need one of the following before step 8:

1. You allow the documentation hosts in this environment's network settings (I will name the exact hosts when we get there and you approve the change), or
2. You paste or upload the relevant API reference pages, or
3. You give me read-only API access to a real or trial instance.

Without any of these, the connectors would be built on guesses, and I would rather tell you that than ship them looking finished.

## 7. Dependencies needing your approval

I will not add any of these without a yes.

| Package                                      | Step | Used for                                                       | If you say no                                                     |
| -------------------------------------------- | ---- | -------------------------------------------------------------- | ----------------------------------------------------------------- |
| A KMS SDK, for example `@aws-sdk/client-kms` | 10   | Wrapping and unwrapping data keys. Depends on decision 2       | Step 10 cannot be done safely; request signing is not hand-rolled |
| `ioredis` in `apps/web`                      | 11   | Rate limits shared across web instances. Already in the worker | Rate limiting stays per instance                                  |

Nothing else. Specifically:

- **Email** calls the provider's HTTP API directly. No SDK, and no `nodemailer` unless you choose SMTP in decision 1.
- **CI** is a workflow file, not a package.
- **Time zones** use the built-in `Intl`.
- **The outbound guard** uses Node's built-in `https` and `dns`.
- **No charting library.** Any new charts are hand-written SVG, like the 14-day strip.

One structural note: notification code lives in `apps/worker` (sending) and `packages/core` (pure batching and message-building rules). I am not adding a new package to the monorepo layout you specified.

## 8. Decisions

Approved as recommended. Decisions 1, 2, 6 and 10 cannot be settled by a recommendation alone, because each needs something only the owner has: an email provider account, a cloud, vendor documentation or access, and Clerk keys. They stay **open** until then. Steps 1 to 6 do not depend on them.

| #   | Question                                                                      | My recommendation                                                                                                                                                                    | Needed by |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| 1   | Email provider                                                                | Resend or Postmark over their HTTP APIs. If you already use AWS, SES instead. Tell me which you have an account with                                                                 | Step 7    |
| 2   | Production KMS cloud (open since Phase 1)                                     | Whichever cloud you will host on. AWS KMS if undecided                                                                                                                               | Step 10   |
| 3   | Can `stale` and `missed` be open on one asset together?                       | Yes. They mean different things and close independently                                                                                                                              | Step 3    |
| 4   | Who can change asset settings                                                 | Technicians can mute for up to 30 days, with a reason. Owners can change expected frequency and SLA, pause, and mute without a limit. Everything is audited                          | Step 4    |
| 5   | VSPC servers with self-signed certificates                                    | Refuse them. Accepting an unverifiable certificate means sending the API key to whoever answers. Revisit with certificate pinning if customers need it                               | Step 8    |
| 6   | Build UniView in this phase?                                                  | Only if one of the three options in section 6 is available. Otherwise move it to Phase 3 and keep this phase honest                                                                  | Step 9    |
| 7   | Deleting an organization in Clerk deletes its data? (open)                    | Yes, after a 30-day hold, as in 4.7                                                                                                                                                  | Step 11   |
| 8   | Retention periods                                                             | Raw payloads 90 days, results 13 months, audit 24 months                                                                                                                             | Step 11   |
| 9   | Queue-level sync retries (open)                                               | No. A failed sync is retried by the next 15-minute tick; retrying sooner mostly hammers a vendor that is already struggling. Rate-limit responses are already honoured inside a sync | Step 11   |
| 10  | Clerk development keys (open)                                                 | Add them as environment variables in this environment's settings, not in chat. Until then, sign-in and every signed-in page remain unverified against a real session                 | Any time  |
| 11  | An asset whose integration has been failing for longer than its backup window | Show it as `unknown` with the reason, and alert on the integration. Not `missed`: we did not see a backup fail to happen, we could not look                                          | Step 2    |

## 9. What I can and cannot verify from here

So that "tests pass" is not read as more than it is:

- **Can verify:** everything against real Postgres and Redis; rules, batching and de-duplication; the outbound guard against local test servers; screenshots through a temporary preview route; CI runs on GitHub.
- **Cannot verify without you:** a real email arriving; a real KMS; Clerk; any vendor API; Docker Compose (image pulls are blocked here); the 3D view on a real GPU.

Each step's report will say which of its claims are tested and which are assumed.

## 10. Progress

| #   | Step                                 | State | Notes                                                                                                                                                                     |
| --- | ------------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | CI                                   | Done  | First run green on `phase-2`; a deliberately broken branch went red. The run also started Postgres and Redis with Docker Compose, which Phase 1 had never been able to do |
| 2   | Vendor data that stops arriving      | Done  | Built without the sweep job the plan described; see the first two changes below                                                                                           |
| 3   | Stale/SLA rule and `stale` incidents | Done  | The SLA applied is never shorter than the asset's backup window; see below                                                                                                |

Changes made during the build:

- **The SLA applied to an asset is never shorter than its backup window** (expected frequency plus grace). Section 4.2 did not say this. Every asset has a 72-hour SLA by default, so without it a weekly asset would be reported stale every week while on schedule. It also makes "stale" strictly an escalation of "missed", which a test checks across every combination of settings.
- **Decision 3 stands:** `stale` and `missed` can be open on one asset together, and in practice always are, because of the rule above.
- **Step 2 has no sweep job.** Section 4.1 planned a worker job that would write `unknown` onto assets every 15 minutes. That job would run in the worker, and the worker being down is one of the two cases it had to catch, so it could not have caught it. The status is worked out when a page is read instead (`statusInView` in `packages/core`), from the stored status, the asset's window and the integration's last successful sync. It needs no job, no cross-tenant function and no extra write, and it holds when nothing is running. Sync failures are counted where they happen, in the sync job.
- **Section 1 overstated the gap.** It said that when a sync fails "the integrations page shows the error, but nothing else does". Phase 1 already turned the affected clients amber and put a notice on the dashboard. What was missing, and is now built: the assets themselves kept their last status and stayed in the "backed up" totals; a worker that had stopped was not detected at all; and nothing recorded how long an integration had been failing or whether waiting could fix it.
- **A stalled state was added** for integrations: nothing failing, nothing arriving. The plan covered failing syncs only.
- **`Integration.lastSyncErrorKind` was added** beside the two planned columns, so a rejected key (which will not fix itself) is treated differently from an outage. The planned definer function was not needed.
- **An asset last seen failed, missed or with a warning keeps that status** when it becomes unconfirmed, instead of turning `unknown`. Decision 11 said "show it as `unknown`"; applied literally, that would downgrade a known failure to amber during an outage.

- **CI starts the services with Docker Compose**, not GitHub's service containers, so the workflow exercises the same `docker-compose.yml` and role script a developer uses.
- **pnpm is installed with Corepack**, which ships with Node, instead of a third-party action.
- **`pnpm db:check` was added** and runs in CI: it fails when the migrated database and the Prisma schema differ. Phase 2 adds several migrations, and this catches a schema edit without one.
- **A weekly run was added** to the push trigger, for advisories and for images or actions that change without a commit.
