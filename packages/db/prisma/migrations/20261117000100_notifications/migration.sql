-- Notifications: where they are sent (channels), what is waiting to be sent
-- (batches, the outbox), and what each channel has already been told
-- (deliveries). All three are tenant-scoped like every other table.

-- CreateEnum
CREATE TYPE "notification_channel_type" AS ENUM ('webhook', 'email');

-- CreateEnum
CREATE TYPE "notification_batch_kind" AS ENUM ('incidents', 'integration', 'test');

-- CreateEnum
CREATE TYPE "notification_batch_status" AS ENUM ('pending', 'sent', 'failed');

-- CreateEnum
CREATE TYPE "incident_event" AS ENUM ('opened', 'closed');

-- AlterTable
ALTER TABLE "integrations" ADD COLUMN     "unhealthy_since" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "notification_channels" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "type" "notification_channel_type" NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "incident_types" "incident_type"[],
    "notify_opened" BOOLEAN NOT NULL DEFAULT true,
    "notify_closed" BOOLEAN NOT NULL DEFAULT true,
    "notify_integration_health" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL DEFAULT '{}',
    "secret_enc" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_batches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "kind" "notification_batch_kind" NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "notification_batch_status" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "sent_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_deliveries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "incident_id" UUID NOT NULL,
    "event" "incident_event" NOT NULL,
    "batch_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notification_channels_tenant_id_name_key" ON "notification_channels"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "notification_channels_tenant_id_id_key" ON "notification_channels"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "notification_batches_tenant_id_channel_id_created_at_idx" ON "notification_batches"("tenant_id", "channel_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "notification_batches_tenant_id_id_key" ON "notification_batches"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "notification_deliveries_tenant_id_batch_id_idx" ON "notification_deliveries"("tenant_id", "batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_deliveries_incident_id_event_channel_id_key" ON "notification_deliveries"("incident_id", "event", "channel_id");

-- CreateIndex
CREATE UNIQUE INDEX "incidents_tenant_id_id_key" ON "incidents"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_batches" ADD CONSTRAINT "notification_batches_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_batches" ADD CONSTRAINT "notification_batches_tenant_id_channel_id_fkey" FOREIGN KEY ("tenant_id", "channel_id") REFERENCES "notification_channels"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_tenant_id_channel_id_fkey" FOREIGN KEY ("tenant_id", "channel_id") REFERENCES "notification_channels"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_tenant_id_incident_id_fkey" FOREIGN KEY ("tenant_id", "incident_id") REFERENCES "incidents"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_tenant_id_batch_id_fkey" FOREIGN KEY ("tenant_id", "batch_id") REFERENCES "notification_batches"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Privileges for the runtime role
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON notification_channels TO valtrexia_app;
-- A batch is written, then updated as it is attempted. It is removed only
-- with its channel, by the foreign key.
GRANT SELECT, INSERT, UPDATE ON notification_batches TO valtrexia_app;
-- A delivery is a fact. It is written once and never changed.
GRANT SELECT, INSERT ON notification_deliveries TO valtrexia_app;

-- ---------------------------------------------------------------------------
-- Row-level security, the same policy as every other tenant table
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['notification_channels', 'notification_batches', 'notification_deliveries']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL
         USING (tenant_id = (SELECT app_current_tenant_id()))
         WITH CHECK (tenant_id = (SELECT app_current_tenant_id()))',
      t
    );
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- Finding what is due, across tenants
-- ---------------------------------------------------------------------------
-- Which batches should be sent now? Ids only, like list_due_integrations: the
-- sending itself then runs inside the tenant's own context.
CREATE FUNCTION list_due_notification_batches(p_limit integer DEFAULT 200)
RETURNS TABLE (batch_id uuid, tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT b.id, b.tenant_id
  FROM public.notification_batches b
  WHERE b.status = 'pending'
    AND b.next_attempt_at <= now()
  ORDER BY b.next_attempt_at ASC, b.id
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 1000)
$$;

REVOKE ALL ON FUNCTION list_due_notification_batches(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_due_notification_batches(integer) TO valtrexia_app;

-- What that function reads: only batches still waiting.
CREATE INDEX notification_batches_due ON notification_batches (next_attempt_at)
  WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- Constraints the Prisma schema cannot express
-- ---------------------------------------------------------------------------
ALTER TABLE notification_channels
  ADD CONSTRAINT notification_channels_name_check CHECK (char_length(btrim(name)) BETWEEN 1 AND 80);

ALTER TABLE notification_batches
  ADD CONSTRAINT notification_batches_attempts_check CHECK (attempts >= 0),
  ADD CONSTRAINT notification_batches_last_error_check
    CHECK (last_error IS NULL OR char_length(last_error) <= 500),
  -- Sent exactly when it has a time it was sent.
  ADD CONSTRAINT notification_batches_sent_at_check CHECK ((status = 'sent') = (sent_at IS NOT NULL));

-- integrations.unhealthy_since is deliberately not tied to the failure count.
-- Replacing an integration's credentials resets the count, but the people
-- told it was unhealthy have not yet been told it recovered: the mark stays
-- until a sync succeeds and says so.
