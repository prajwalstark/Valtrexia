-- Key rotation: finding encrypted records across tenants.
--
-- The rotation command moves each record's wrapped data key to the current
-- key. Like list_due_integrations, these functions return ids, and the key id
-- each record is wrapped under, and nothing else: no ciphertext, no wrapped
-- key. The re-wrapping itself then runs inside each tenant's own context.

-- Encrypted records whose key id differs from p_exclude_key_id, in a stable
-- order, one page after the given position (NULLs: from the start).
CREATE FUNCTION list_encrypted_records(
  p_exclude_key_id text,
  p_after_tenant uuid,
  p_after_type text,
  p_after_id uuid,
  p_limit integer DEFAULT 200
)
RETURNS TABLE (tenant_id uuid, record_type text, record_id uuid, key_id text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT r.tenant_id, r.record_type, r.record_id, r.key_id
  FROM (
    SELECT i.tenant_id, 'integration'::text AS record_type, i.id AS record_id,
           i.credentials_enc ->> 'keyId' AS key_id
    FROM public.integrations i
    UNION ALL
    SELECT c.tenant_id, 'notification_channel'::text, c.id, c.secret_enc ->> 'keyId'
    FROM public.notification_channels c
    WHERE c.secret_enc IS NOT NULL
  ) r
  WHERE r.key_id IS DISTINCT FROM p_exclude_key_id
    AND (
      p_after_tenant IS NULL
      OR (r.tenant_id, r.record_type COLLATE "C", r.record_id)
         > (p_after_tenant, p_after_type COLLATE "C", p_after_id)
    )
  ORDER BY r.tenant_id, r.record_type COLLATE "C", r.record_id
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 1000)
$$;

REVOKE ALL ON FUNCTION list_encrypted_records(text, uuid, text, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_encrypted_records(text, uuid, text, uuid, integer) TO valtrexia_app;

-- How many records of each kind are wrapped under each key: what a rotation
-- has left to do.
CREATE FUNCTION count_encrypted_records_by_key()
RETURNS TABLE (record_type text, key_id text, records bigint)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT r.record_type, r.key_id, count(*)
  FROM (
    SELECT 'integration'::text AS record_type, i.credentials_enc ->> 'keyId' AS key_id
    FROM public.integrations i
    UNION ALL
    SELECT 'notification_channel'::text, c.secret_enc ->> 'keyId'
    FROM public.notification_channels c
    WHERE c.secret_enc IS NOT NULL
  ) r
  GROUP BY r.record_type, r.key_id
  ORDER BY r.record_type, r.key_id
$$;

REVOKE ALL ON FUNCTION count_encrypted_records_by_key() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION count_encrypted_records_by_key() TO valtrexia_app;
