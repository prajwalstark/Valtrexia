-- The status of an asset's most recent backup result, kept beside
-- last_result_at. current_status can be "missed", which is derived and so
-- hides what the vendor last reported; this column preserves it.
ALTER TABLE "assets" ADD COLUMN "last_result_status" "backup_status";
