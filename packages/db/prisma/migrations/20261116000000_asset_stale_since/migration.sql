-- When an asset went past its SLA without a completed backup. Set and
-- cleared by the sync job alongside the `stale` incident it corresponds to,
-- so pages can show it without joining incidents.
ALTER TABLE "assets" ADD COLUMN "stale_since" TIMESTAMPTZ(3);
