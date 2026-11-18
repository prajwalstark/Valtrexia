# Phase 3 plan

Status: **approved** ("go with your recommendations"). Branch: `phase-3`, cut from `main` after the Phase 2 merge (`78af022`). Progress will be recorded in section 10.

Phase 1's plan stays in `PLAN.md` and Phase 2's in `PLAN-PHASE-2.md`, as the record of what was built.

---

## 1. Where Phase 2 left things

Every v1 feature in the brief is built: three vendors, the backup rules, incidents, alerting by webhook and email, encrypted credentials with AWS KMS, retention, offboarding and a strict Content-Security-Policy. 1,352 tests pass against real Postgres and Redis. What stands between that and an MSP relying on it:

1. **It cannot be deployed.** There are no container images, no health or readiness endpoints, and no deployment guide. The README explains how to run it on a laptop. Production requirements are enforced (TLS, KMS, Redis), but nothing tells an operator how to meet them.
2. **Nothing has met a real service.** Clerk, Datto, VSPC, UniView, AWS KMS, a managed Postgres and Redis: all are tested against stand-ins only. Email cannot be sent at all; no provider has been chosen.
3. **The operator is blind.** If syncs fail across every tenant, the worker stops, or webhooks pile up, nothing tells the people running the service. The app shows a stopped worker to whoever is looking at a dashboard, and that is all. There is no backup or restore procedure for the application's own database.
4. **The open items in `SECURITY.md`:** monitoring and alerting, database backups, data export and an independent review.

Not built, and asked for by MSPs in practice: reports they can show their clients, tickets in their PSA, and a way to take their data with them. Smaller things left from Phase 2: notification channels cannot be edited, the incident queue cannot be grouped by asset, there has been no phone-width layout pass, and VSPC covers VM and agent jobs only, with history starting the day it is connected.

## 2. What Phase 3 delivers

Five groups, in this order. Each is useful if the phase stops after it.

| Group                   | Outcome                                                                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Deployable, operable | Container images, health checks and a deployment guide for AWS. Email actually sends. The operator is alerted when the service itself is unwell. Backups have a tested restore drill. |
| B. Proven               | Each real service checked as soon as you provide access: Clerk, the three vendors, KMS, email, a staging deployment. Not a numbered step, because it waits on you.                    |
| C. What MSPs ask for    | Workspace data export, client backup reports, tickets in one PSA, and the small workflow gaps closed.                                                                                 |
| D. Coverage and scale   | VSPC's other job types and history from restore points. Measured performance at a stated scale, with fixes where it falls short.                                                      |
| E. Assurance            | An automated security review and an accessibility audit across every page, and the scope for an external review.                                                                      |

**Still out of scope after Phase 3:** billing, a second PSA, SSO beyond what Clerk offers (Clerk's enterprise SSO is configuration and will be documented, not built), a mobile app, multi-region deployment, infrastructure as code (see decision 2), and any write action against a backup vendor. Valtrexia remains read-only towards backup vendors. Creating a PSA ticket (step 7) is a write to the PSA, never to a backup job.

## 3. Task order

As before: every step ends with `pnpm check` and a short report of what changed, and is committed and pushed to `phase-3`. Nothing needing a dependency or a decision starts until you have answered.

| #   | Step                                                                                                                                                 | Needs from you               | Verified by                                                                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Deployment packaging: images for web and worker, a migration task, health and readiness endpoints, a worker heartbeat, an AWS deployment guide       | Decision 2                   | Images built and started in CI against Postgres and Redis; endpoints tested; images checked for non-root user and no secrets inside |
| 2   | Email provider                                                                                                                                       | Done, no real email sent yet | Resend, built from its API reference; a real send waits for your key and an address                                                 |
| 2   | Email provider: the real `EmailSender`, with permanent and temporary failures told apart                                                             | Decision 1, an API key       | Tests against a stand-in built from the provider's API docs; one real email to an address you give                                  |
| 3   | Operator monitoring: fleet-wide checks, an operator alert destination, a protected status endpoint for an external monitor, metric lines in the logs | Decision 3                   | A test per condition: alerts once when it starts, once when it clears; a stopped worker detected from outside it                    |
| 4   | Backups and restore drill: a `pnpm db:verify` command for a restored copy, and an operations runbook                                                 | Nothing                      | Dump, restore into an empty database, verify passes; deliberately damaged copies fail with a clear reason                           |
| 5   | Workspace data export for owners                                                                                                                     | Decision 4                   | Export contents tested in two tenants; secrets searched for in the output; rate limit and audit tested                              |
| 6   | Client backup reports: a printable monthly report per client, and a monthly digest email                                                             | Decision 5                   | Report figures tested against fixed histories, including months with gaps and clock changes; print layout checked in a browser      |
| 7   | Tickets in one PSA, as a notification channel                                                                                                        | Decision 6, API access       | Tests against a stand-in built from the PSA's published API; one ticket per problem however often a delivery is retried             |
| 8   | Workflow polish: edit a notification channel; group the incident queue by asset; phone-width layout pass on every page                               | Decision 7                   | Action tests; screenshots of every page at 360 px                                                                                   |
| 9   | VSPC coverage: backup copy, file share and Microsoft 365 jobs, and history filled in from restore points                                             | Nothing                      | Fixtures from Veeam's specification, as in Phase 2; deliberate breaks; still unverified against a real console                      |
| 10  | Scale: generate the target fleet, measure, fix what falls short                                                                                      | Decision 8                   | Measured numbers before and after, recorded in this plan                                                                            |
| 11  | Assurance: an automated security review of the whole codebase, an accessibility audit of every page, and a scope document for an external review     | Decisions 9 and 10           | Findings fixed or recorded with a reason; no axe violations on any page                                                             |
| 12  | Final pass: documentation, a fresh clone, and a deployment from the built images                                                                     | Nothing                      | Everything green                                                                                                                    |

**Floating task: live verification.** Whenever you provide Clerk keys, a vendor account, a KMS key, an email provider key or a staging environment, I stop the current step, check against the real service, and fix what differs. Each is listed in section 9.

The natural cuts are after step 4 (deployable and operable, no new features) and after step 8.

## 4. Designs that need more than a line

### 4.1 Deployment shape (step 1)

- **Two images**, web and worker, each a multi-stage build from the lockfile. The web app uses Next.js's standalone output. Both run as a non-root user on a read-only filesystem, and contain no `.env` or key material.
- **Migrations run as a one-off task** before a deploy, with the owner database URL. Only that task gets the owner URL; the web and worker containers only ever get the app role's.
- **Configuration comes from the environment**, filled from AWS Secrets Manager by the platform. The guide lists every variable, which service needs it, and which are secret.
- **Health:** `GET /api/health` answers when the process is up and checks nothing else. `GET /api/ready` answers when the database (as the app role) and Redis respond. Both return a status code and nothing that describes the system. The worker writes a heartbeat to Redis every 30 seconds; a small command reads it for the container's health check.
- **The guide** covers ECS on Fargate, RDS for Postgres 16, ElastiCache for Redis 7 with TLS and a password, KMS, Secrets Manager, an Application Load Balancer, and the order of first deployment. It is written to be followed by a person, not run as code (decision 2).

Docker can build here but cannot pull base images (the network blocks the registries), so images are built and started in CI, where they can be. I will say which checks ran where.

### 4.2 Operator monitoring (step 3)

The hard part is that a stopped worker cannot report its own death. So there are two layers:

1. **Inside the worker,** a check every few minutes over the whole fleet. Counts only, never tenant names or data:

   | Condition                                            | Default threshold         |
   | ---------------------------------------------------- | ------------------------- |
   | Share of integrations whose last sync failed         | Over 25%, with at least 4 |
   | Integrations not synced within twice the interval    | Any, for 30 minutes       |
   | Notification batches that failed permanently         | Any in the last hour      |
   | Pending notification batches past their next attempt | Over 100 for 15 minutes   |
   | Maintenance (retention, deletions) failed            | Any                       |

   Each condition alerts once when it starts and once when it clears. The state is kept in a small table outside the tenant model, added deliberately to the catalog test. Alerts go to an operator destination set by configuration (decision 3), sent through the same outbound guard and retry rules as tenant notifications.

2. **Outside the worker,** `GET /api/status` on the web app, protected by a bearer token from configuration, reports the worker heartbeat's age, queue depths and the counts above. An external monitor polls it (CloudWatch Synthetics, or any uptime service) and alerts when the worker is silent or the web app does not answer. The guide shows how to set one up; I cannot run one from here.

Every check also writes one structured log line with its numbers, so CloudWatch metric filters can chart them without a metrics library.

### 4.3 Backups (step 4)

RDS takes the backups and keeps point-in-time recovery; the guide says how to set retention. What this step adds is proof that a restore works: `pnpm db:verify` checks a restored database for migrations at head, row-level security on every tenant table, the app role still unable to bypass it, the definer functions intact, and one stored credential decrypting with the configured key. It refuses to call a restore good without all five. The runbook covers deploying, migrating, rotating keys, restoring, offboarding a tenant by hand, and what to do when an operator alert fires.

### 4.4 Data export (step 5)

Owners download one gzipped JSON file: workspace settings, clients, assets with their settings, backup results within retention, incidents, notification channels (names and settings only) and the audit log. It never contains credentials, webhook URLs, signing secrets or raw vendor payloads. Raw payloads are excluded because they can hold vendor-side detail the app never shows. It is streamed, written to the audit log, and limited to one per workspace per hour. An export is offered on the deletion screen, so leaving no longer means losing history.

### 4.5 Client reports (step 6)

One report per client per calendar month, in the workspace's time zone:

- Assets protected, and assets muted or paused.
- **Backup success:** the share of days on which each asset had a completed backup (success or warning), averaged over assets. This is a day-based measure, so it does not depend on how often a vendor runs jobs.
- **SLA:** the share of asset-days spent inside the asset's SLA.
- Incidents opened and closed, with the median time to close, by type.
- The month's strip for each asset, worst first.

The report is a page styled for printing; "Save as PDF" in the browser produces the file. There is no server-side PDF, which would mean running a browser in production. A monthly digest email to the workspace's email channels links to each client's report. Reports go to the MSP only in this phase (decision 5).

### 4.6 PSA tickets (step 7)

A new notification channel type, so it inherits the outbox, retries and de-duplication:

- Each client is mapped to a PSA company, chosen from a list read from the PSA.
- One ticket per asset problem. Further incidents on the same asset add a note to the open ticket, and the ticket is closed, or moved to a status you choose, when the asset's last incident closes.
- The PSA's ticket id is stored against the incident in the same transaction as the delivery, so a retry adds to the same ticket instead of opening another.
- PSA credentials are stored with the same envelope encryption as vendor keys, under their own purpose label.

The PSA's API is new ground, with the same rule as the vendors: built from its published documentation, isolated behind the channel, marked unverified until it meets a real instance.

## 5. Schema changes

All additive, each in the step that needs it.

| Step | Change                                                                                                                                              |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3    | `operator_alerts` (condition, opened, cleared): outside the tenant model, no tenant data, not readable by the app role beyond what the worker needs |
| 7    | Notification channel type `psa`; `psa_company_mappings` and `psa_tickets` as tenant tables, with policies                                           |
| 10   | Indexes, only where a measurement shows they are needed                                                                                             |

Every new tenant table is added to the tenant isolation tests in the same step, and every new definer function to the catalog test.

## 6. Uncertainty

- **The PSA's API.** I have not read it. As with the vendors, I need the documentation hosts allowed in this environment, the pages themselves, or a sandbox. I will name the hosts when we get there.
- **The email provider's API.** Resend and Postmark publish small, well-documented HTTP APIs, and I expect no surprises. I will still read the current documentation rather than rely on memory.
- **Veeam's other job types.** The specification obtained in Phase 2 covers them. Whether restore points are a faithful history of past backups is an assumption to check on a real console.
- **Performance at scale.** I have not measured any of it. Step 10 measures before it changes anything, and records the numbers whether or not they are good.

## 7. Dependencies needing your approval

I will not add any of these without a yes.

| Package                                            | Step | Used for                                     | If you say no                           |
| -------------------------------------------------- | ---- | -------------------------------------------- | --------------------------------------- |
| `@axe-core/playwright` (development only)          | 11   | Automated accessibility checks on every page | The audit is done by hand, page by page |
| `@aws-sdk/client-sesv2`, only if decision 1 is SES | 2    | Signing requests to SES                      | Choose Resend or Postmark instead       |

Nothing else:

- **Email (Resend or Postmark) and the PSA** are called over HTTP with `fetch`.
- **Images** are Dockerfiles, not packages.
- **No metrics, tracing or error-tracking library.** Structured log lines feed CloudWatch (decision 3).
- **No PDF or zip library.** Reports print from the browser; exports are gzipped JSON with Node's built-in `zlib`.

## 8. Decisions

| #   | Question                                    | My recommendation                                                                                                                                                                                     | Needed by |
| --- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 1   | Email provider (open since Phase 2)         | Postmark or Resend, whichever you have an account with: plain HTTP, no new dependency. SES fits an AWS deployment but needs the AWS SDK for request signing                                           | Step 2    |
| 2   | Where it runs, and how it is described      | AWS, since KMS is already AWS: ECS on Fargate, RDS, ElastiCache. Container images and a written guide in this phase; infrastructure as code (Terraform or CDK) later, once the shape has settled      | Step 1    |
| 3   | Where operator alerts go                    | An operator email address and an optional webhook (a Slack incoming webhook works), set in configuration. No error-tracking service for now; logs go to CloudWatch                                    | Step 3    |
| 4   | What a data export contains                 | Everything in 4.4, excluding credentials, destinations and raw vendor payloads. Owners only, one an hour                                                                                              | Step 5    |
| 5   | Who sees client reports                     | The MSP only, in this phase: a printable page and a monthly digest to the MSP's own email channels. Sending reports to end clients needs client contacts and unsubscribe handling; later              | Step 6    |
| 6   | Which PSA                                   | The one your MSPs use most. If unsure, ConnectWise PSA. One ticket per asset problem, closed when the asset recovers                                                                                  | Step 7    |
| 7   | Per-user notification preferences           | Do not build. Channels already let a workspace send different things to different people                                                                                                              | Step 8    |
| 8   | Scale target                                | 200 workspaces, 50,000 assets, 13 months of history. Pages under 500 ms of server time at the 95th percentile; a full sync of every integration within the 15-minute interval on two worker processes | Step 10   |
| 9   | Accessibility tooling                       | Yes to `@axe-core/playwright`, development only                                                                                                                                                       | Step 11   |
| 10  | External review                             | Commission a penetration test before the first paying customer. The author, human or AI, cannot be the independent reviewer. I will write its scope in step 11                                        | Step 11   |
| 11  | Clerk development keys (open since Phase 2) | Add them as environment variables in this environment's settings, not in chat                                                                                                                         | Any time  |

## 9. What I can and cannot verify from here

- **Can verify:** everything against real Postgres and Redis; images built and started in CI; health endpoints; restore drills against local Postgres; report arithmetic; the stand-ins for the email provider and the PSA; performance on generated data; pages in a browser.
- **Cannot verify without you:** a deployment to AWS; a real email arriving; a real PSA; Clerk; any vendor; KMS; an external monitor polling the status endpoint; whether the performance holds on your hardware.

Each step's report will say which of its claims are tested and which are assumed.

## 10. Progress

| #   | Step                 | State | Notes                                                                                                               |
| --- | -------------------- | ----- | ------------------------------------------------------------------------------------------------------------------- |
| 1   | Deployment packaging | Done  | Images built and run as production would, locally and in CI; the AWS guide is written but not yet followed for real |

Changes made during the build:

- **Decision 1 is settled: Resend.** Sent over its HTTP API with `fetch`; no new dependency. With approval, `resend.com` was added to this environment so its documentation could be read; the API host (`api.resend.com`) is not allowed yet and is only needed for a real send from here.
- **The idempotency key includes a hash of the message**, not only its id. Resend refuses a repeat whose body differs from the first, and a body can change between attempts if the channel is renamed or the time zone changes. With the id alone, such a message would have failed for good; with the hash, it is sent.
- **A rejected key or unverified sender domain is retried**, not given up on, because the operator may fix it within the retry window (about 8 hours). The notifications page says the operator needs to fix the email settings. Step 3's operator alerts will make sure someone is told.
- **Resend's error messages are never shown or logged**: some quote recipients' addresses. Only the status and Resend's error type are logged.
- **Decisions 1 to 11 are taken as recommended.** Decision 1 (email provider) and decision 6 (which PSA) still need your account or choice before steps 2 and 7. Decision 11 (Clerk keys) is unchanged.
- **The Clerk publishable key is read at run time**, as `CLERK_PUBLISHABLE_KEY` (the old `NEXT_PUBLIC_` name still works). Before, it was baked into the build, so each environment would have needed its own image. The build now needs no keys at all.
- **Prisma's migration engine does not verify certificates under `sslmode=verify-full`.** Found by connecting to a test server whose certificate nothing trusted: it connected. It does verify under `sslmode=require&sslaccept=strict`. The migrate image refuses any owner URL without those, and the guide gives the right form. The apps use the Node driver, which does verify under `verify-full`.
- **Amazon RDS's certificate authority is not trusted by default.** The guide adds AWS's bundle to the images in a two-line derived image, read through `NODE_EXTRA_CA_CERTS` by the apps and through `sslcert` by the migration engine.
- **The migrate image is built on the full Node image, not the slim one.** Prisma's migration engine needs OpenSSL, which the slim image lacks, and picks its build by the OpenSSL it finds at install time. On the slim image it fetched the wrong one.
- **The worker runs its TypeScript through `tsx`**, now a runtime dependency of the worker at the version the repository already used. No build step for the worker.
- **The worker image is larger than it needs to be** (about 800 MB): Prisma's CLI comes along as a peer dependency of its client. Harmless; trimming it is left for later.
- **Images were built and run here**, not only in CI: a Docker daemon could be started in this environment, and the smoke test passed locally before it ran in CI.
