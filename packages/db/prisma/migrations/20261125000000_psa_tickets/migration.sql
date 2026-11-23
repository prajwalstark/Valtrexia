-- PSA tickets: a notification channel that opens, updates and closes tickets
-- in the MSP's PSA (Syncro first), one per asset problem.

-- AlterEnum
ALTER TYPE "notification_channel_type" ADD VALUE 'psa';

-- AlterTable
ALTER TABLE "notification_batches" ADD COLUMN     "asset_id" UUID;

-- CreateTable
CREATE TABLE "psa_customer_mappings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "external_customer_id" TEXT NOT NULL,
    "external_customer_name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "psa_customer_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "psa_tickets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "external_customer_id" TEXT NOT NULL,
    "external_ticket_id" TEXT,
    "external_ticket_number" TEXT,
    "subject" TEXT NOT NULL,
    "create_started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_batch_id" UUID,
    "closed_at" TIMESTAMPTZ(3),
    "close_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "psa_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "psa_customer_mappings_tenant_id_client_id_idx" ON "psa_customer_mappings"("tenant_id", "client_id");

-- CreateIndex
CREATE UNIQUE INDEX "psa_customer_mappings_channel_id_client_id_key" ON "psa_customer_mappings"("channel_id", "client_id");

-- CreateIndex
CREATE UNIQUE INDEX "psa_customer_mappings_tenant_id_id_key" ON "psa_customer_mappings"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "psa_tickets_tenant_id_channel_id_asset_id_idx" ON "psa_tickets"("tenant_id", "channel_id", "asset_id");

-- CreateIndex
CREATE UNIQUE INDEX "psa_tickets_tenant_id_id_key" ON "psa_tickets"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "notification_batches_tenant_id_channel_id_asset_id_created__idx" ON "notification_batches"("tenant_id", "channel_id", "asset_id", "created_at");

-- AddForeignKey
ALTER TABLE "psa_customer_mappings" ADD CONSTRAINT "psa_customer_mappings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "psa_customer_mappings" ADD CONSTRAINT "psa_customer_mappings_tenant_id_channel_id_fkey" FOREIGN KEY ("tenant_id", "channel_id") REFERENCES "notification_channels"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "psa_customer_mappings" ADD CONSTRAINT "psa_customer_mappings_tenant_id_client_id_fkey" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "clients"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "psa_tickets" ADD CONSTRAINT "psa_tickets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "psa_tickets" ADD CONSTRAINT "psa_tickets_tenant_id_channel_id_fkey" FOREIGN KEY ("tenant_id", "channel_id") REFERENCES "notification_channels"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "psa_tickets" ADD CONSTRAINT "psa_tickets_tenant_id_asset_id_fkey" FOREIGN KEY ("tenant_id", "asset_id") REFERENCES "assets"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Rules the Prisma schema cannot express
-- ---------------------------------------------------------------------------
-- Webhook and PSA channels hold an encrypted secret; email channels none.
-- Compared as text: a value added to an enum cannot be used as one in the
-- same transaction that added it.
ALTER TABLE notification_channels
  DROP CONSTRAINT notification_channels_secret_check,
  ADD CONSTRAINT notification_channels_secret_check
    CHECK ((type::text IN ('webhook', 'psa')) = (secret_enc IS NOT NULL));

-- At most one open ticket per channel and asset, however many workers try.
CREATE UNIQUE INDEX psa_tickets_one_open_per_asset
  ON psa_tickets (channel_id, asset_id) WHERE closed_at IS NULL;

ALTER TABLE psa_tickets
  ADD CONSTRAINT psa_tickets_close_reason_check
    CHECK (close_reason IS NULL OR close_reason IN ('resolved', 'closed_in_psa')),
  ADD CONSTRAINT psa_tickets_closed_has_reason_check
    CHECK ((closed_at IS NULL) = (close_reason IS NULL)),
  ADD CONSTRAINT psa_tickets_external_ids_check
    CHECK (length(external_customer_id) BETWEEN 1 AND 40
       AND (external_ticket_id IS NULL OR length(external_ticket_id) BETWEEN 1 AND 40));

ALTER TABLE psa_customer_mappings
  ADD CONSTRAINT psa_customer_mappings_external_check
    CHECK (length(external_customer_id) BETWEEN 1 AND 40
       AND length(external_customer_name) BETWEEN 1 AND 200);

-- ---------------------------------------------------------------------------
-- Privileges for the runtime role
-- ---------------------------------------------------------------------------
-- Owners choose, change and remove mappings.
GRANT SELECT, INSERT, UPDATE, DELETE ON psa_customer_mappings TO valtrexia_app;
-- A ticket record is written, then updated as the ticket progresses. It is
-- removed only with its channel or asset, by the foreign keys.
GRANT SELECT, INSERT, UPDATE ON psa_tickets TO valtrexia_app;

-- ---------------------------------------------------------------------------
-- Row-level security, the same policy as every other tenant table
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['psa_customer_mappings', 'psa_tickets']
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
