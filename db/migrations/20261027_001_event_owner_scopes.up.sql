-- Applied version: 20261027_001_event_owner_scopes.
-- Delivery checks the owner scopes without a direct read of api_credentials.
-- fad_app must not receive SELECT on that table.
-- The function returns scope names only. It does not return key material.
-- The organization comes from fad.org_id. No down script.

CREATE FUNCTION fad_s7_principal_scopes(p_principal_id uuid)
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT COALESCE(array_agg(DISTINCT scope), ARRAY[]::text[])
    FROM (
      SELECT unnest(c.scopes) AS scope
        FROM public.api_credentials AS c
       WHERE c.organization_id = nullif(current_setting('fad.org_id', true), '')::uuid
         AND c.principal_id = p_principal_id
         AND c.status = 'active'
         AND c.revoked_at IS NULL
         AND (c.expires_at IS NULL OR c.expires_at > transaction_timestamp())
    ) AS active_scopes
$function$;

ALTER FUNCTION fad_s7_principal_scopes(uuid) OWNER TO fad_auth_reader;
REVOKE ALL ON FUNCTION fad_s7_principal_scopes(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fad_s7_principal_scopes(uuid) TO fad_app;
