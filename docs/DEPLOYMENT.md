# Deploying Valtrexia

How to run Valtrexia in production on AWS. **This guide has not been followed against a real AWS account yet.** The images it deploys are built and run in CI as production would (read-only, unprivileged, over TLS; see [Checked in CI](#checked-in-ci)), but the AWS resources, permissions and networking below are written from AWS's documentation and have not been exercised. Treat the first deployment as the test of this guide, and correct it where AWS differs.

The shape: one ECS cluster on Fargate running the web app behind an Application Load Balancer and the worker on its own, with Postgres on RDS, Redis on ElastiCache, keys in KMS, and configuration in Secrets Manager. Infrastructure as code is deliberately left for later (Phase 3 plan, decision 2); every resource here is listed so it can be written as code once the shape has settled.

## 1. The images

One `Dockerfile` at the repository root builds three images:

| Target    | Runs                                                                     | Command                                    |
| --------- | ------------------------------------------------------------------------ | ------------------------------------------ |
| `web`     | The Next.js server, on port 3000                                         | `node apps/web/server.js`                  |
| `worker`  | Syncs, notifications and maintenance; also the seed and rotation scripts | `node --import tsx src/index.ts`           |
| `migrate` | Applies pending migrations as the owner role, then exits                 | `prisma migrate deploy`, after a URL check |

Each image runs as the unprivileged `node` user, needs nothing writable except `/tmp`, and contains no configuration: every setting arrives as an environment variable when the container starts, so the same images serve staging and production.

```bash
docker build --target web -t valtrexia-web:$(git rev-parse --short HEAD) .
```

```bash
docker build --target worker -t valtrexia-worker:$(git rev-parse --short HEAD) .
```

```bash
docker build --target migrate -t valtrexia-migrate:$(git rev-parse --short HEAD) .
```

Push them to an ECR repository each, tagged with the commit. Never deploy `latest`.

### Trusting the RDS certificate

Production connections verify the database's certificate (`sslmode=verify-full`), and Amazon RDS's certificate authority is not in Node's or Debian's default list. Add AWS's bundle on top of the images:

```dockerfile
# deploy.Dockerfile: build once per image, with --build-arg BASE=<image>
ARG BASE
FROM ${BASE}
COPY --chown=root:root rds-global-bundle.pem /certs/rds.pem
ENV NODE_EXTRA_CA_CERTS=/certs/rds.pem
```

Download `rds-global-bundle.pem` from AWS's documentation page "Using SSL/TLS to encrypt a connection to a DB instance", check it, and commit it with your deployment configuration. ElastiCache's certificates are issued by Amazon Trust Services, which is already trusted.

The migration image reads the same file differently: Prisma's migration engine ignores `NODE_EXTRA_CA_CERTS`, so its URL names the file (see `DATABASE_URL_OWNER` below).

## 2. AWS resources

Create these in one region, the same as the KMS key.

1. **Network.** A VPC with private subnets in at least two availability zones for the tasks, the database and Redis, and public subnets for the load balancer. A NAT gateway: the worker calls vendor APIs, webhook destinations and Resend (`api.resend.com`) on the internet, and the web app calls Clerk and, for connection tests, the vendors.
2. **Security groups.** Load balancer: 443 from anywhere. Web tasks: 3000 from the load balancer only. Database: 5432 from the web, worker and migrate tasks only. Redis: 6379 from the web and worker tasks only.
3. **RDS for PostgreSQL 16.** Encrypted storage, automated backups with point-in-time recovery, kept at least 14 days, and deletion protection (restoring, and the quarterly restore drill, are in [RUNBOOK.md](./RUNBOOK.md#2-backups-and-restoring)), `rds.force_ssl` on (the default from PostgreSQL 15). The master user becomes the **owner** role: it owns the tables and is used only by the migration task. Then create the runtime role once, as the master user:

   ```sql
   CREATE ROLE valtrexia_app LOGIN PASSWORD '<generated>' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
   ```

   This is what `docker/postgres/init/01-app-role.sh` does locally. The migrations grant it what it needs; the apps refuse to start if it can bypass row-level security or owns a table.

4. **ElastiCache for Redis 7**, or Valkey with Redis compatibility, with encryption in transit and an AUTH token (or a user with a password). Set its eviction policy to `noeviction`: the job queues must never lose a key.
5. **KMS.** A symmetric customer managed key with an alias such as `alias/valtrexia`, and automatic key rotation turned on. See "Key management" in the README.
6. **Secrets Manager.** One secret per sensitive value in [section 3](#3-configuration).
7. **ECR** repositories for the three images, with scan on push.
8. **IAM.**
   - The **task execution role**, shared: pull from ECR, read the secrets, write logs.
   - The **web and worker task role**: `kms:Encrypt` and `kms:Decrypt` on the key, and nothing else from AWS.
   - The **migrate task role**: no AWS permissions at all.
9. **ECS cluster** on Fargate, with the services and task in [section 4](#4-ecs).
10. **Application Load Balancer** with an HTTPS listener (an ACM certificate for your domain), redirecting HTTP to HTTPS, forwarding to the web service's target group.

## 3. Configuration

Every variable, which image needs it, and whether it is a secret. Secrets come from Secrets Manager through the task definition's `secrets`; the rest go in `environment`.

| Variable                                                                  | web | worker | migrate | Secret | Value                                                                                                           |
| ------------------------------------------------------------------------- | :-: | :----: | :-----: | :----: | --------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                            |  ✓  |   ✓    |         |   ✓    | `postgresql://valtrexia_app:…@<rds-endpoint>:5432/valtrexia?sslmode=verify-full`                                |
| `DATABASE_URL_OWNER`                                                      |     |        |    ✓    |   ✓    | `postgresql://<master>:…@<rds-endpoint>:5432/valtrexia?sslmode=require&sslaccept=strict&sslcert=/certs/rds.pem` |
| `REDIS_URL`                                                               |  ✓  |   ✓    |         |   ✓    | `rediss://default:<token>@<elasticache-endpoint>:6379`                                                          |
| `CLERK_PUBLISHABLE_KEY`                                                   |  ✓  |        |         |        | From your Clerk **production** instance                                                                         |
| `CLERK_SECRET_KEY`                                                        |  ✓  |        |         |   ✓    | From the same instance                                                                                          |
| `CLERK_WEBHOOK_SIGNING_SECRET`                                            |  ✓  |        |         |   ✓    | From the webhook endpoint you create in Clerk ([section 6](#6-first-deployment))                                |
| `VALTREXIA_KEY_PROVIDER`                                                  |  ✓  |   ✓    |         |        | `aws-kms`                                                                                                       |
| `VALTREXIA_KMS_KEY_ID`                                                    |  ✓  |   ✓    |         |        | The key's alias ARN, `arn:aws:kms:<region>:<account>:alias/valtrexia`                                           |
| `AWS_REGION`                                                              |  ✓  |   ✓    |         |        | Optional; defaults to the key's region                                                                          |
| `EMAIL_PROVIDER`                                                          |  ✓  |   ✓    |         |        | `resend`                                                                                                        |
| `RESEND_API_KEY`                                                          |     |   ✓    |         |   ✓    | A Resend API key with sending access only                                                                       |
| `EMAIL_FROM`                                                              |     |   ✓    |         |        | `Valtrexia <alerts@yourmsp.com>`, on a domain verified in Resend                                                |
| `EMAIL_REPLY_TO`                                                          |     |   ✓    |         |        | Optional                                                                                                        |
| `SYNC_INTERVAL_MINUTES`                                                   |  ✓  |   ✓    |         |        | Optional, default 15. The same value on both                                                                    |
| `SYNC_CONCURRENCY`, `SCHEDULER_TICK_SECONDS`, `NOTIFICATION_TICK_SECONDS` |     |   ✓    |         |        | Optional; defaults in the README's Worker section                                                               |
| `RETENTION_*_DAYS`                                                        |     |   ✓    |         |        | Optional; defaults 90, 395 and 730                                                                              |
| `WORKER_INSTANCE_ID`                                                      |     |   ✓    |         |        | Leave unset on Fargate: each task's host name is unique                                                         |
| `LOG_LEVEL`                                                               |  ✓  |   ✓    |         |        | Optional, default `info`                                                                                        |
| `OPERATOR_ALERT_EMAIL`                                                    |     |   ✓    |         |        | Who is alerted about the service itself; comma-separated                                                        |
| `OPERATOR_ALERT_WEBHOOK_URL`                                              |     |   ✓    |         |   ✓    | Optional: a Slack incoming webhook, or any HTTPS endpoint                                                       |
| `OPERATOR_ALERT_WEBHOOK_SECRET`                                           |     |   ✓    |         |   ✓    | Optional: signs the webhook (`whsec_…`)                                                                         |
| `OPERATOR_CHECK_SECONDS`                                                  |  ✓  |   ✓    |         |        | Optional, default 300. The same value on both                                                                   |
| `OPERATOR_STATUS_TOKEN`                                                   |  ✓  |        |         |   ✓    | Turns on `/api/status`; at least 32 characters                                                                  |

`NODE_ENV=production` is set in the images. In production the apps refuse to start, or report not ready, if the database URL does not use `sslmode=verify-full`, if Redis is not `rediss://` with a password, or if the key provider is `local`. The migrate image refuses an owner URL that would not verify the certificate. Never set `VALTREXIA_ENABLE_MOCK`, `VALTREXIA_LOCAL_KEK`, `VALTREXIA_PREVIOUS_LOCAL_KEKS` or `VALTREXIA_ALLOW_PRIVATE_DESTINATIONS` in production; the apps ignore or refuse them there.

`DATABASE_URL_OWNER` is the only way into the database with the power to change its structure. Give it to the migrate task alone.

## 4. ECS

All task definitions: Fargate, Linux/x86_64, `readonlyRootFilesystem: true` with an ephemeral volume mounted at `/tmp`, logs to CloudWatch with the `awslogs` driver (the apps write one JSON object per line, with credentials redacted).

**migrate** (a task definition, not a service): 0.25 vCPU, 512 MB. Run it with `aws ecs run-task` before every deployment and wait for it to exit 0. It applies only migrations that have not run, so running it again is harmless.

**worker** (a service, no load balancer): 0.5 vCPU, 1 GB to start. Two tasks for resilience; the queues make sure each sync and each message is handled once. Container health check:

```json
["CMD", "node", "--import", "tsx", "src/scripts/healthcheck.ts"]
```

with interval 30, timeout 10, retries 3, start period 60. It passes while the worker's heartbeat in Redis is less than 90 seconds old. Stopping a task lets running syncs finish: set the stop timeout to 120 seconds.

**web** (a service behind the load balancer): 0.5 vCPU, 1 GB, two tasks or more. Port 3000. Container health check:

```json
[
  "CMD",
  "node",
  "-e",
  "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
]
```

Target group health check: path `/api/ready`, expecting 200. The two endpoints differ on purpose:

| Endpoint      | Answers 200 when                                        | Used by                                                                           |
| ------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `/api/health` | The process is up. Checks nothing else                  | The container health check, so a database outage never restarts healthy web tasks |
| `/api/ready`  | The database answers as the app role, and Redis answers | The load balancer, so traffic goes only to tasks that can serve it                |

Both answer without a session and outside Clerk's middleware, and say nothing about the system beyond `ok`, `ready`, or which part is not ready.

## 5. Watching the service

The worker alerts `OPERATOR_ALERT_EMAIL` and `OPERATOR_ALERT_WEBHOOK_URL` about fleet-wide problems (README, "Operator monitoring"). It cannot report its own death, so something outside must poll `/api/status`:

1. Set `OPERATOR_STATUS_TOKEN` on the web service.
2. Create a CloudWatch Synthetics canary (or use any uptime service) that requests `https://<your-domain>/api/status` every 5 minutes with the header `Authorization: Bearer <token>` (store the token in Secrets Manager for the canary), and fails on anything but 200.
3. Alarm on the canary's failures, to the same people as the operator alerts. Also alarm on the load balancer's healthy host count for the web service, which covers the web app itself.

The response names what is wrong (`no_worker_heartbeat`, `fleet_check_stale`, or an alert's condition) and gives counts only.

Each fleet check also logs one line with `"metric":"fleet_health"` and every number; a CloudWatch metric filter on it can chart failing integrations and queue depth over time.

## 6. First deployment

1. Create the resources in [section 2](#2-aws-resources) and the secrets in [section 3](#3-configuration).
2. Create the `valtrexia_app` role in the database (section 2, item 3).
3. Build the images with the RDS bundle added, and push them.
4. Run the migrate task. It must exit 0.
5. Start the worker service. Its tasks should become healthy within a minute; its log says `Valtrexia worker is running`.
6. Start the web service. The target group should show the tasks healthy.
7. In Clerk's production instance: set the allowed origins and redirect URLs to your domain, require multi-factor authentication, and add a webhook endpoint at `https://<your-domain>/api/webhooks/clerk` subscribed to `organization.*` and `organizationMembership.*`. Put its signing secret in `CLERK_WEBHOOK_SIGNING_SECRET` and redeploy the web service.
8. Sign up, set up two-step verification, create a workspace and connect a vendor. Its first sync should finish within a few minutes.

## 7. Every later deployment

1. Build and push the three images for the new commit.
2. Run the migrate task with the new migrate image. Migrations are additive by convention (README, "Changing the schema"), so the version still running keeps working against the new schema while the services roll over.
3. Update the worker service, then the web service, to the new images. ECS replaces tasks one at a time; a task is only sent traffic once `/api/ready` passes.

To roll back, deploy the previous images. Migrations are not rolled back: being additive, the previous version runs against the newer schema.

## Checked in CI

`docker/smoke/run.sh`, run by CI on every push, builds the three images and runs them as this guide describes: read-only with `/tmp` writable, as the `node` user, in production mode, against a Postgres and a Redis that accept only TLS, with a throwaway certificate authority supplied the same way as the RDS bundle. It checks:

- No image contains an environment file or a key.
- The migrate image refuses an owner URL that would not verify the certificate, then applies the migrations over verified TLS.
- The web app answers `/api/health`, `/api/ready` and the sign-in page, with a nonce-based Content-Security-Policy, and its container health check passes.
- A web app given an unencrypted Redis URL reports not ready.
- The worker starts, writes its heartbeat, runs maintenance, and passes its health check.
- `/api/status` refuses a wrong token, reports ok with the worker running, and turns to 503 naming the missing heartbeat when the worker is stopped; without a token configured it does not exist.
- A worker given an unencrypted database URL refuses to start, without printing the URL.

What CI cannot check is everything AWS-specific: IAM, the RDS certificate bundle, ElastiCache's TLS, KMS, the load balancer and networking.
