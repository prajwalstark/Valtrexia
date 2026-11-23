# Operations runbook

What to do, step by step, for the routine and the unusual. For people running Valtrexia in production as [DEPLOYMENT.md](./DEPLOYMENT.md) describes. Like that guide, **this has not been practised against a real AWS account yet**; the commands it relies on are tested (see each section), the AWS steps are not.

Commands shown as `pnpm …` run from a checkout with production settings in the environment. In production, run the same thing as a one-off ECS task from the image named, with the service's environment: for example `node --import tsx src/scripts/verify-database.ts` in the worker image is `pnpm db:verify`.

## Contents

1. [Deploying and rolling back](#1-deploying-and-rolling-back)
2. [Backups and restoring](#2-backups-and-restoring)
3. [Operator alerts](#3-operator-alerts)
4. [Other incidents](#4-other-incidents)
5. [Keys and secrets](#5-keys-and-secrets)
6. [Deleting a workspace by hand](#6-deleting-a-workspace-by-hand)

## 1. Deploying and rolling back

Follow [DEPLOYMENT.md, "Every later deployment"](./DEPLOYMENT.md#7-every-later-deployment): build and push the three images, run the migrate task and wait for it to exit 0, then update the worker and web services.

- **The migrate task failed.** The services were not updated, so the running version carries on. Prisma records the failed migration and stops; read the task's log, fix the cause, then follow Prisma's guidance for a failed migration (`prisma migrate resolve`) before running the task again. It refuses to start with an owner URL that would not verify the database's certificate: use `sslmode=require&sslaccept=strict&sslcert=…`, not `verify-full`.
- **New tasks do not become healthy.** The web target group checks `/api/ready`: a 503 names `database` or `redis`. The worker's container check reads its heartbeat. In production both refuse to start without TLS settings (`Insecure connection settings.` in the log names which). Roll back if it is not quick to fix.
- **Rolling back** means deploying the previous images. Migrations are additive, so the previous version runs against the newer schema; do not try to undo a migration.

## 2. Backups and restoring

**What holds state.** Only Postgres. Redis holds queues, rate-limit counts and heartbeats, all of which rebuild themselves: the worker re-creates its schedules when it starts, and every message waiting to be sent is in Postgres (the notification outbox), not in Redis. The KMS key is what makes the database's encrypted values readable; without it a backup is only partly useful.

**Backups.** RDS automated backups with point-in-time recovery, retained for at least 14 days, plus a manual snapshot before any risky change. Turn on deletion protection for the database. **Never schedule the KMS key for deletion**: every stored credential would become unreadable, in every backup.

**The restore drill.** Every quarter, and after any change to the database's setup:

1. Restore the latest automated backup to a **new** RDS instance (point-in-time restore). Never restore over the live one.
2. Run the verification against it, as a one-off task from the worker image with the production environment, except `DATABASE_URL` pointing at the restored instance:

   ```bash
   pnpm db:verify
   ```

   It connects as the runtime role, exactly as the app does, and runs five checks:

   | Check        | Passes when                                                                                                     |
   | ------------ | --------------------------------------------------------------------------------------------------------------- |
   | `migrations` | Every migration in this release has run, and no migration unknown to it                                         |
   | `isolation`  | Row-level security is on, with a policy, for every table holding tenant data                                    |
   | `role`       | The connection is `valtrexia_app`, which is not a superuser, cannot bypass row-level security and owns no table |
   | `functions`  | The cross-tenant functions are exactly the expected ones, each pinned and executable by the runtime role only   |
   | `encryption` | Every key the credentials are wrapped under is configured, and one record per key decrypts                      |

   It prints one line per check and exits 0 only if all five pass. A failure names what is wrong (a table, a function, a migration, a key id) and never prints a credential.

3. Write down the date, the backup's time, how long the restore took and the result. Then delete the restored instance.

**Recovering for real.** Restore to a new instance as above and run `pnpm db:verify` against it. Only if every check passes: point the `DATABASE_URL` and `DATABASE_URL_OWNER` secrets at the new instance, run the migrate task (it applies anything the backup predates), and redeploy the worker and web services. Data written after the restore point is lost; the next syncs re-read recent backup results from the vendors, but changes people made in that window must be redone.

_Tested:_ `packages/db/src/verify.db.test.ts` dumps a database with `pg_dump`, restores it with `pg_restore` into an empty one, and runs the verification, then damages the restored copy one way at a time (a table without row-level security, a function opened to everyone or closed to the app, a migration missing or unknown, the wrong key, a damaged ciphertext, the wrong role) and checks each is caught. CI also runs the verification from the worker image against a freshly migrated database over TLS.

## 3. Operator alerts

Alerts arrive by email (`OPERATOR_ALERT_EMAIL`) and webhook (`OPERATOR_ALERT_WEBHOOK_URL`), once when a condition starts and once when it clears. The worker's log has a `"metric":"fleet_health"` line every five minutes with the numbers. See README, "Operator monitoring".

| Condition               | First checks                                                                                                                                                     | Usual fixes                                                                                                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `integrations_failing`  | The worker's log: `sync failed` lines and their `kind`. Many `network` or `vendor` at once means the vendor or the worker's network, not the workspaces.         | A vendor outage passes by itself; syncs retry every 15 minutes. Check the NAT gateway and security groups if every vendor fails. `auth` failures are each workspace's own keys. |
| `integrations_overdue`  | Is a worker running? `/api/status` and the worker service's task count. Is it syncing? Its log should show `sync finished` lines.                                | Restart the worker service. If syncs run but take longer than the interval, raise `SYNC_CONCURRENCY` or add a worker task.                                                      |
| `notifications_failing` | The notifications page of an affected workspace shows each message's last error. The worker's log: `email service refused a message` with Resend's error `type`. | A rejected key or unverified sender domain: fix `RESEND_API_KEY` or `EMAIL_FROM` and redeploy the worker. Webhook failures are each tenant's endpoint.                          |
| `notifications_backlog` | Is a worker running? Resend's rate limit (`rate_limit_exceeded` in the log)?                                                                                     | Restart the worker; ask Resend for a higher rate.                                                                                                                               |
| `maintenance_failing`   | The worker's log: `maintenance failed`, with the error.                                                                                                          | Usually the database (a lock, or a full disk). Maintenance runs again within six hours; it can wait for a fix.                                                                  |

**`/api/status` answers 503.** The body names the problem:

- `no_worker_heartbeat`: no worker has checked in for 90 seconds. Check the worker service; restart it. While it is down nothing syncs and nothing is sent, but nothing is lost: syncs and messages resume where they stopped.
- `fleet_check_stale`: workers beat, but the fleet check has not run for three intervals. Look for `operator check failed` in the worker's log; usually the database.
- A condition name: as the table above.

## 4. Other incidents

- **KMS unavailable.** Syncs fail as `internal` with "The encryption key service could not be reached", webhooks wait, and owners saving keys are told nothing was saved. Nothing is lost and nobody is told to re-enter keys. Check AWS's status and the task role's `kms:Decrypt` and `kms:Encrypt` permissions. Everything resumes when KMS answers.
- **Resend down or refusing.** Email notifications wait and retry for about eight hours, then are given up on (`notifications_failing`). Webhook channels are unaffected.
- **A vendor's API is down.** That vendor's integrations fail and retry every 15 minutes; after an hour each is marked unhealthy and its workspace's channels are told. Assets show as unconfirmed, not as missed. Nothing to do but watch.
- **Clerk is down.** Nobody can sign in; the worker keeps syncing and alerting. Nothing to do on our side.
- **One workspace's integration rejects its keys.** The workspace's owner must replace them on the integration's page; they are told by their own notification channels. This is not an operator problem.

## 5. Keys and secrets

- **Moving to a new KMS key.** README, "Rotating the key": configure the new key as current, keep the old one readable, deploy, then `pnpm keys:rotate` until it reports every record moved, then remove the old key. AWS's own yearly rotation of a key's material needs nothing.
- **Database passwords.** Set a new password for the role in RDS, update the secret, redeploy. Change `valtrexia_app`'s with `ALTER ROLE valtrexia_app PASSWORD …` as the owner.
- **Redis token, Resend key, Clerk keys, status token, operator webhook secret.** Create the new value at its source, update the secret, redeploy the services that use it (see the table in DEPLOYMENT.md), then revoke the old value. Rotate the Clerk webhook's signing secret in Clerk and `CLERK_WEBHOOK_SIGNING_SECRET` together.
- **A secret leaked.** Revoke it at its source first, then replace it as above, then look in CloudTrail (KMS) or the provider's logs for its use. Stored credentials are encrypted with KMS; a leaked database dump without the KMS key's use does not expose them.

## 6. Deleting a workspace by hand

Normally an owner asks in Settings, or deleting the organization in Clerk starts it, and the data is deleted after 30 days (README, "Deleting a workspace").

- **Undo a deletion started by Clerk** (an organization deleted by mistake, within the 30 days). Recreating the organization in Clerk gives it a new id, so the workspace must be relinked by hand. As the database owner, clear the tenant's three deletion columns:

  ```sql
  UPDATE tenants SET deletion_requested_at = NULL, delete_after = NULL, deletion_reason = NULL
  WHERE clerk_org_id = 'org_…';
  ```

  Then link it to the organization that replaces it: `UPDATE tenants SET clerk_org_id = 'org_new…' WHERE clerk_org_id = 'org_old…';`. Record what you did and why.

- **Delete sooner than 30 days** (a request to erase data). The database refuses a hold shorter than seven days. As the owner, set `delete_after` to seven days after the request, or, if the law requires sooner, delete the tenant directly and record it:

  ```sql
  INSERT INTO tenant_deletions (deleted_tenant_id, clerk_org_id, tenant_name, reason, requested_at)
  SELECT id, clerk_org_id, name, 'owner_request', now() FROM tenants WHERE id = '…';
  DELETE FROM tenants WHERE id = '…';
  ```

  Every table holding the workspace's data cascades from `tenants`. Backups still hold it until they expire.
