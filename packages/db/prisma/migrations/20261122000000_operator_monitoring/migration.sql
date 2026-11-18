-- Operator monitoring: alerts to the people running the service, about the
-- service itself, and the counts they are based on.

-- CreateTable
CREATE TABLE "operator_alerts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "condition" TEXT NOT NULL,
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(3),
    "details" JSONB NOT NULL DEFAULT '{}',
    "open_notified_at" TIMESTAMPTZ(3),
    "close_notified_at" TIMESTAMPTZ(3),

    CONSTRAINT "operator_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "operator_alerts_opened_at_idx" ON "operator_alerts"("opened_at" DESC);

-- At most one open alert per condition, however many workers check at once.
CREATE UNIQUE INDEX operator_alerts_one_open_per_condition
  ON operator_alerts (condition) WHERE closed_at IS NULL;

ALTER TABLE operator_alerts
  ADD CONSTRAINT operator_alerts_condition_check CHECK (condition ~ '^[a-z_]{1,64}$'),
  ADD CONSTRAINT operator_alerts_closed_after_opened_check
    CHECK (closed_at IS NULL OR closed_at >= opened_at);

-- Not tenant data: no tenant_id, no names, only counts. The worker opens and
-- closes alerts and the web app's status endpoint reads them, both as the
-- runtime role. Alerts are never deleted by the app.
GRANT SELECT, INSERT, UPDATE ON operator_alerts TO valtrexia_app;

-- ---------------------------------------------------------------------------
-- The fleet's health, as counts across every tenant
-- ---------------------------------------------------------------------------
-- Ids are not returned, let alone names: a number per measure. Workspaces
-- waiting to be deleted are left out, since nothing runs for them.
CREATE FUNCTION fleet_health_counts(p_overdue interval)
RETURNS TABLE (
  integrations_total bigint,
  integrations_failing bigint,
  integrations_overdue bigint,
  batches_overdue bigint,
  batches_failed_last_hour bigint
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT
    (SELECT count(*) FROM public.integrations i JOIN public.tenants t ON t.id = i.tenant_id
      WHERE t.deletion_requested_at IS NULL),
    (SELECT count(*) FROM public.integrations i JOIN public.tenants t ON t.id = i.tenant_id
      WHERE t.deletion_requested_at IS NULL AND i.sync_status = 'error'),
    (SELECT count(*) FROM public.integrations i JOIN public.tenants t ON t.id = i.tenant_id
      WHERE t.deletion_requested_at IS NULL
        AND COALESCE(i.last_sync_at, i.created_at) < now() - p_overdue),
    (SELECT count(*) FROM public.notification_batches b JOIN public.tenants t ON t.id = b.tenant_id
      WHERE t.deletion_requested_at IS NULL
        AND b.status = 'pending' AND b.next_attempt_at < now() - interval '15 minutes'),
    (SELECT count(*) FROM public.notification_batches b JOIN public.tenants t ON t.id = b.tenant_id
      WHERE t.deletion_requested_at IS NULL
        AND b.status = 'failed' AND b.updated_at > now() - interval '1 hour')
$$;

REVOKE ALL ON FUNCTION fleet_health_counts(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fleet_health_counts(interval) TO valtrexia_app;
