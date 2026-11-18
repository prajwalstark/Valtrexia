-- Tenant offboarding: a workspace can be marked for deletion, by Clerk
-- deleting its organization or by an owner. Syncing and notifications stop at
-- once; after a hold, maintenance deletes everything in one cascade from
-- tenants and records that it did, outside the tenant.

-- CreateEnum
CREATE TYPE "tenant_deletion_reason" AS ENUM ('organization_deleted', 'owner_request');

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "delete_after" TIMESTAMPTZ(3),
ADD COLUMN     "deletion_reason" "tenant_deletion_reason",
ADD COLUMN     "deletion_requested_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "tenant_deletions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "deleted_tenant_id" UUID NOT NULL,
    "clerk_org_id" TEXT NOT NULL,
    "tenant_name" TEXT NOT NULL,
    "reason" "tenant_deletion_reason" NOT NULL,
    "requested_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_deletions_pkey" PRIMARY KEY ("id")
);


-- ---------------------------------------------------------------------------
-- Marking a workspace for deletion
-- ---------------------------------------------------------------------------
-- The app marks and unmarks through the tenant's own context. It cannot
-- delete a tenant: only purge_due_tenants() does, once the hold has passed.
GRANT UPDATE (deletion_requested_at, delete_after, deletion_reason) ON tenants TO valtrexia_app;

-- All three set together, or none; and never a hold shorter than a week,
-- whatever the application asks for.
ALTER TABLE tenants ADD CONSTRAINT tenants_deletion_check CHECK (
  (deletion_requested_at IS NULL AND delete_after IS NULL AND deletion_reason IS NULL)
  OR (
    deletion_requested_at IS NOT NULL AND delete_after IS NOT NULL AND deletion_reason IS NOT NULL
    AND delete_after >= deletion_requested_at + interval '7 days'
  )
);

CREATE INDEX tenants_delete_after ON tenants (delete_after) WHERE delete_after IS NOT NULL;

-- The record of deletions belongs to the operator. The runtime role has no
-- privileges on it, and row-level security with no policy denies any other
-- role that is not its owner.
ALTER TABLE tenant_deletions ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- A workspace waiting for deletion is not synced or notified
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION list_due_integrations(p_interval interval, p_limit integer DEFAULT 500)
RETURNS TABLE (integration_id uuid, tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT i.id, i.tenant_id
  FROM public.integrations i
  JOIN public.tenants t ON t.id = i.tenant_id
  WHERE t.deletion_requested_at IS NULL
    AND (i.last_sync_started_at IS NULL OR i.last_sync_started_at <= now() - p_interval)
  ORDER BY i.last_sync_started_at ASC NULLS FIRST, i.id
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 500), 1), 1000)
$$;

CREATE OR REPLACE FUNCTION list_due_notification_batches(p_limit integer DEFAULT 200)
RETURNS TABLE (batch_id uuid, tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT b.id, b.tenant_id
  FROM public.notification_batches b
  JOIN public.tenants t ON t.id = b.tenant_id
  WHERE t.deletion_requested_at IS NULL
    AND b.status = 'pending'
    AND b.next_attempt_at <= now()
  ORDER BY b.next_attempt_at ASC, b.id
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 1000)
$$;

-- ---------------------------------------------------------------------------
-- Deleting workspaces whose hold has passed
-- ---------------------------------------------------------------------------
-- Each is recorded in tenant_deletions, then deleted with everything it owns
-- (every tenant table cascades from tenants). Returns the ids deleted.
CREATE FUNCTION purge_due_tenants(p_limit integer DEFAULT 10)
RETURNS TABLE (deleted_tenant_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT t.id, t.clerk_org_id, t.name, t.deletion_reason, t.deletion_requested_at
    FROM public.tenants t
    WHERE t.delete_after IS NOT NULL AND t.delete_after <= now()
    ORDER BY t.delete_after, t.id
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 10), 1), 100)
    FOR UPDATE SKIP LOCKED
  LOOP
    INSERT INTO public.tenant_deletions
      (deleted_tenant_id, clerk_org_id, tenant_name, reason, requested_at)
    VALUES (r.id, r.clerk_org_id, r.name, r.deletion_reason, r.deletion_requested_at);
    DELETE FROM public.tenants WHERE id = r.id;
    deleted_tenant_id := r.id;
    RETURN NEXT;
  END LOOP;
END
$$;

REVOKE ALL ON FUNCTION purge_due_tenants(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_due_tenants(integer) TO valtrexia_app;
