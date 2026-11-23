-- Which migrations a database has, for `pnpm db:verify`, which checks a
-- restored database as the runtime role. Prisma's own table belongs to the
-- owner and also holds logs; this returns the names of finished migrations
-- and nothing else.
CREATE FUNCTION applied_migrations()
RETURNS TABLE (migration_name text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT m.migration_name::text
  FROM public._prisma_migrations m
  WHERE m.finished_at IS NOT NULL AND m.rolled_back_at IS NULL
  ORDER BY m.migration_name
$$;

REVOKE ALL ON FUNCTION applied_migrations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION applied_migrations() TO valtrexia_app;
