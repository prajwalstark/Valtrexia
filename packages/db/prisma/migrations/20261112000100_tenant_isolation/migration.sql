-- Tenant isolation: runtime role, grants, row-level security, the three
-- functions that run before a tenant context exists, and constraints that the
-- Prisma schema cannot express.
--
-- The model
--   * Tables are owned by the role that runs migrations. That role is never
--     used by the running application.
--   * The application connects as valtrexia_app, which owns nothing, is not a
--     superuser and cannot bypass row-level security.
--   * Every query the application makes runs in a transaction that first sets
--     app.tenant_id. Policies compare each row's tenant_id with it. With no
--     tenant set the comparison is against NULL, so nothing matches.
--
-- Row-level security is ENABLED but not FORCED. FORCE only changes behaviour
-- for the table owner, which the application never is; and the functions
-- below run as the owner precisely so they can make three narrow
-- cross-tenant lookups. The application verifies at startup that it is not
-- connected as a privileged role (see src/role-guard.ts).

-- ---------------------------------------------------------------------------
-- Runtime role
-- ---------------------------------------------------------------------------
-- Normally created up front with a password (docker/postgres/init, or by hand
-- on managed Postgres). Created here without login if it is missing, so the
-- grants below always have a target.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'valtrexia_app') THEN
    CREATE ROLE valtrexia_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Tenant context
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid
$$;

COMMENT ON FUNCTION app_current_tenant_id() IS
  'Tenant id set for the current transaction, or NULL when none is set.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO valtrexia_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  users, integrations, clients, vendor_client_mappings, assets, backup_results, incidents
TO valtrexia_app;

-- Append-only: no UPDATE, no DELETE.
GRANT SELECT, INSERT ON audit_logs TO valtrexia_app;

-- Tenants are created only through provision_tenant() and never deleted by
-- the application. It may read its own row and change these columns.
GRANT SELECT ON tenants TO valtrexia_app;
GRANT UPDATE (name, grace_hours, updated_at) ON tenants TO valtrexia_app;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
-- The policies apply to every role (no TO clause), so a role added later is
-- tenant-scoped by default. The SELECT wrapper makes Postgres evaluate the
-- tenant id once per statement instead of once per row.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'integrations', 'clients', 'vendor_client_mappings',
    'assets', 'backup_results', 'incidents', 'audit_logs'
  ]
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

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_self_select ON tenants FOR SELECT
  USING (id = (SELECT app_current_tenant_id()));

CREATE POLICY tenant_self_update ON tenants FOR UPDATE
  USING (id = (SELECT app_current_tenant_id()))
  WITH CHECK (id = (SELECT app_current_tenant_id()));

-- ---------------------------------------------------------------------------
-- Functions that run before a tenant context exists
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER: they run as the owner and so see across tenants. Each one
-- is deliberately narrow, pins search_path, schema-qualifies every reference,
-- and is executable only by the runtime role.

-- Which tenant is this Clerk organization? Returns NULL when there is none.
CREATE FUNCTION resolve_tenant_id(p_clerk_org_id text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT t.id FROM public.tenants t WHERE t.clerk_org_id = p_clerk_org_id
$$;

-- Creates the tenant for a Clerk organization, or returns the existing one.
-- An existing tenant is returned unchanged; its name is not overwritten.
CREATE FUNCTION provision_tenant(p_clerk_org_id text, p_name text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_clerk_org_id IS NULL OR btrim(p_clerk_org_id) = '' THEN
    RAISE EXCEPTION 'clerk organization id is required' USING ERRCODE = '22023';
  END IF;
  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'tenant name is required' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.tenants (clerk_org_id, name)
  VALUES (p_clerk_org_id, btrim(p_name))
  ON CONFLICT (clerk_org_id) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT t.id INTO v_id FROM public.tenants t WHERE t.clerk_org_id = p_clerk_org_id;
  END IF;

  RETURN v_id;
END
$$;

-- Which integrations should the scheduler sync now? Returns ids only: no
-- names, no credentials. The sync itself then runs inside the tenant context.
-- An integration is due when no sync has started within p_interval.
CREATE FUNCTION list_due_integrations(p_interval interval, p_limit integer DEFAULT 500)
RETURNS TABLE (integration_id uuid, tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT i.id, i.tenant_id
  FROM public.integrations i
  WHERE i.last_sync_started_at IS NULL
     OR i.last_sync_started_at <= now() - p_interval
  ORDER BY i.last_sync_started_at ASC NULLS FIRST, i.id
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 500), 1), 1000)
$$;

REVOKE ALL ON FUNCTION resolve_tenant_id(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION provision_tenant(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION list_due_integrations(interval, integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION resolve_tenant_id(text) TO valtrexia_app;
GRANT EXECUTE ON FUNCTION provision_tenant(text, text) TO valtrexia_app;
GRANT EXECUTE ON FUNCTION list_due_integrations(interval, integer) TO valtrexia_app;

-- ---------------------------------------------------------------------------
-- Constraints the Prisma schema cannot express
-- ---------------------------------------------------------------------------
ALTER TABLE tenants
  ADD CONSTRAINT tenants_grace_hours_check CHECK (grace_hours BETWEEN 0 AND 168);

ALTER TABLE assets
  ADD CONSTRAINT assets_expected_frequency_hours_check CHECK (expected_frequency_hours > 0),
  ADD CONSTRAINT assets_sla_hours_check CHECK (sla_hours > 0);

ALTER TABLE backup_results
  ADD CONSTRAINT backup_results_ended_after_started_check
    CHECK (ended_at IS NULL OR ended_at >= started_at);

ALTER TABLE incidents
  ADD CONSTRAINT incidents_closed_after_opened_check
    CHECK (closed_at IS NULL OR closed_at >= opened_at);

-- At most one open incident per asset per type.
CREATE UNIQUE INDEX incidents_one_open_per_asset_type
  ON incidents (asset_id, type)
  WHERE closed_at IS NULL;
