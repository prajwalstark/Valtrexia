-- Sync failure tracking, so an integration that keeps failing can be told
-- apart from one that failed once, and so the kind of failure is known.
CREATE TYPE "sync_error_kind" AS ENUM (
  'auth',
  'credentials',
  'rate_limited',
  'network',
  'vendor',
  'invalid_response',
  'unavailable',
  'internal'
);

ALTER TABLE "integrations"
  ADD COLUMN "last_sync_error_kind" "sync_error_kind",
  ADD COLUMN "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "failing_since" TIMESTAMPTZ(3);

-- Integrations that are failing right now. How many times they have failed
-- was never recorded, so they start at one; the kind is unknown until their
-- next attempt.
UPDATE "integrations"
SET "consecutive_failures" = 1,
    "failing_since" = COALESCE("last_sync_started_at", now()),
    "last_sync_error_kind" = 'internal'
WHERE "sync_status" = 'error';

-- Constraints the Prisma schema cannot express.
ALTER TABLE "integrations"
  ADD CONSTRAINT integrations_consecutive_failures_check CHECK (consecutive_failures >= 0),
  -- A run of failures has a start exactly when it has a length.
  ADD CONSTRAINT integrations_failing_since_check
    CHECK ((consecutive_failures > 0) = (failing_since IS NOT NULL));
