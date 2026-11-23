-- Monthly reports: the summary email sent early each month, and a channel
-- preference for it.

-- AlterEnum
ALTER TYPE "notification_batch_kind" ADD VALUE 'report';

-- AlterTable
ALTER TABLE "notification_channels" ADD COLUMN "notify_monthly_report" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN "last_report_digest_month" TEXT;

ALTER TABLE tenants
  ADD CONSTRAINT tenants_last_report_digest_month_check
    CHECK (last_report_digest_month IS NULL OR last_report_digest_month ~ '^2[0-9]{3}-(0[1-9]|1[0-2])$');

-- The worker records the month it queued, inside the tenant's own context.
GRANT UPDATE (last_report_digest_month) ON tenants TO valtrexia_app;

-- ---------------------------------------------------------------------------
-- Which workspaces are due their monthly summary
-- ---------------------------------------------------------------------------
-- At p_now, in the first p_window_days days of a month in each workspace's
-- own time zone, a workspace is due the summary of the month before unless
-- it has had it. Only workspaces with an enabled channel that wants it, and none
-- waiting to be deleted. Returns ids and the month only.
CREATE FUNCTION list_report_digest_tenants(p_now timestamptz, p_window_days integer DEFAULT 7)
RETURNS TABLE (tenant_id uuid, month text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT t.id, d.month
  FROM public.tenants t
  CROSS JOIN LATERAL (
    SELECT to_char(date_trunc('month', p_now AT TIME ZONE t.time_zone) - interval '1 month', 'YYYY-MM') AS month,
           extract(day FROM p_now AT TIME ZONE t.time_zone) AS day
  ) d
  WHERE t.deletion_requested_at IS NULL
    AND d.day <= LEAST(GREATEST(COALESCE(p_window_days, 7), 1), 28)
    AND t.last_report_digest_month IS DISTINCT FROM d.month
    AND EXISTS (
      SELECT 1 FROM public.notification_channels c
      WHERE c.tenant_id = t.id AND c.enabled AND c.notify_monthly_report
    )
  ORDER BY t.id
  LIMIT 1000
$$;

REVOKE ALL ON FUNCTION list_report_digest_tenants(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_report_digest_tenants(timestamptz, integer) TO valtrexia_app;
