-- Retention: old data is removed on a schedule, across tenants.
--
-- The runtime role cannot delete audit entries (the log is append-only to
-- it), and must not be able to: a compromised app could then erase its own
-- tracks. Retention runs instead through this one SECURITY DEFINER function,
-- which only removes data older than periods it refuses to shorten below a
-- floor.

-- CreateIndex
CREATE INDEX "backup_results_started_at_idx" ON "backup_results"("started_at");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- One batch of retention work. Returns how many rows each part touched;
-- the caller repeats while any part filled its batch.
--   - Raw vendor payloads on results older than p_payload_days are emptied.
--     The normalized result stays.
--   - Results older than p_result_days are deleted.
--   - Audit entries older than p_audit_days are deleted.
CREATE FUNCTION apply_retention(
  p_payload_days integer,
  p_result_days integer,
  p_audit_days integer,
  p_batch integer DEFAULT 5000
)
RETURNS TABLE (payloads_cleared bigint, results_deleted bigint, audit_deleted bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_batch integer := LEAST(GREATEST(COALESCE(p_batch, 5000), 1), 50000);
  v_payloads bigint;
  v_results bigint;
  v_audit bigint;
BEGIN
  IF p_payload_days IS NULL OR p_payload_days < 7
     OR p_result_days IS NULL OR p_result_days < 30
     OR p_audit_days IS NULL OR p_audit_days < 90 THEN
    RAISE EXCEPTION 'Retention periods may not be shorter than 7 days (payloads), 30 days (results) and 90 days (audit entries).';
  END IF;

  WITH doomed AS (
    SELECT r.id FROM public.backup_results r
    WHERE r.started_at < now() - make_interval(days => p_payload_days)
      AND r.raw_payload <> '{}'::jsonb
    LIMIT v_batch
  )
  UPDATE public.backup_results r SET raw_payload = '{}'::jsonb
  FROM doomed WHERE r.id = doomed.id;
  GET DIAGNOSTICS v_payloads = ROW_COUNT;

  WITH doomed AS (
    SELECT r.id FROM public.backup_results r
    WHERE r.started_at < now() - make_interval(days => p_result_days)
    LIMIT v_batch
  )
  DELETE FROM public.backup_results r USING doomed WHERE r.id = doomed.id;
  GET DIAGNOSTICS v_results = ROW_COUNT;

  WITH doomed AS (
    SELECT a.id FROM public.audit_logs a
    WHERE a.created_at < now() - make_interval(days => p_audit_days)
    LIMIT v_batch
  )
  DELETE FROM public.audit_logs a USING doomed WHERE a.id = doomed.id;
  GET DIAGNOSTICS v_audit = ROW_COUNT;

  RETURN QUERY SELECT v_payloads, v_results, v_audit;
END
$$;

REVOKE ALL ON FUNCTION apply_retention(integer, integer, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION apply_retention(integer, integer, integer, integer) TO valtrexia_app;
