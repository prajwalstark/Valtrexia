-- Who muted an asset, when, and why. Kept on the asset while the mute stands;
-- the audit log holds the history.
ALTER TABLE "assets"
  ADD COLUMN "muted_reason" TEXT,
  ADD COLUMN "muted_by_user_id" UUID,
  ADD COLUMN "muted_at" TIMESTAMPTZ(3);

ALTER TABLE "assets" ADD CONSTRAINT "assets_tenant_id_muted_by_user_id_fkey"
  FOREIGN KEY ("tenant_id", "muted_by_user_id") REFERENCES "users"("tenant_id", "id")
  ON DELETE NO ACTION ON UPDATE CASCADE;

-- Constraints the Prisma schema cannot express.
ALTER TABLE "assets"
  ADD CONSTRAINT assets_muted_reason_length_check
    CHECK (muted_reason IS NULL OR char_length(muted_reason) BETWEEN 1 AND 500),
  -- One hour to one year. The lower bounds already exist; these add the upper.
  ADD CONSTRAINT assets_expected_frequency_hours_max_check CHECK (expected_frequency_hours <= 8760),
  ADD CONSTRAINT assets_sla_hours_max_check CHECK (sla_hours <= 8760);
