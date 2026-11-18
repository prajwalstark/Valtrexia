-- The time zone a workspace reads dates in. Stored values stay in UTC; this
-- only decides how they are shown and where one day ends and the next begins.
ALTER TABLE "tenants" ADD COLUMN "time_zone" TEXT NOT NULL DEFAULT 'UTC';

-- The application checks the name against the zones it can format. This only
-- keeps the column from holding something absurd.
ALTER TABLE "tenants"
  ADD CONSTRAINT tenants_time_zone_check CHECK (char_length(time_zone) BETWEEN 1 AND 64);

-- The application role may change this column of its own tenant row, as it
-- already may the name and the grace period.
GRANT UPDATE (time_zone) ON tenants TO valtrexia_app;

-- The incident queue lists a tenant's open incidents oldest first.
CREATE INDEX incidents_open_queue ON incidents (tenant_id, opened_at) WHERE closed_at IS NULL;
