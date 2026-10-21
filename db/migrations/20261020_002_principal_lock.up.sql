-- Lock a principal row without granting fad_app UPDATE on principals.
-- fad_app has SELECT only. SELECT FOR SHARE needs UPDATE, which stays with
-- fad_bootstrap. The lock is held until the caller transaction ends.
-- The predicate uses the transaction-local tenant. A mismatch returns no row.

CREATE FUNCTION fad_lock_principal(p_org uuid, p_id uuid)
RETURNS text
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT status
  FROM public.principals
  WHERE organization_id = p_org
    AND id = p_id
    AND organization_id = nullif(current_setting('fad.org_id', true), '')::uuid
  FOR SHARE
$function$;

ALTER FUNCTION fad_lock_principal(uuid, uuid) OWNER TO fad_bootstrap;
REVOKE ALL ON FUNCTION fad_lock_principal(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fad_lock_principal(uuid, uuid) TO fad_app;
