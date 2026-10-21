-- Applied version: 20261023_001_mcp_identity_bindings.
-- The package file is 20261021_004_mcp_identity_bindings.up.sql. That name
-- sorts before the shipped Slice 3 migration, so this copy uses a later
-- version. The SQL statements are the package statements. No down script.

-- FAD Slice 4: OAuth subject -> existing tenant principal mapping.
-- PostgreSQL 16+. Run as privileged migration role using the Slice 0 runner.
-- Runner encloses this file and schema_migrations checksum insertion in one
-- transaction with an advisory migration lock. NEVER run as fad_app.
-- Prerequisite: Slices 0-3 applied and read-only old application contracts.

-- Non-login reader can only read the mapping table, through a fixed
-- SECURITY DEFINER function. It cannot read any other tenant tables.
DO $fad$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fad_mcp_auth_reader') THEN
   CREATE ROLE fad_mcp_auth_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
 END IF;
END
$fad$;

GRANT USAGE ON SCHEMA public TO fad_mcp_auth_reader;

CREATE TABLE mcp_principal_bindings (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  oauth_issuer varchar(512) NOT NULL,
  oauth_subject varchar(512) NOT NULL,
  oauth_client_id varchar(256) NOT NULL,
  allowed_scopes text[] NOT NULL,
  status varchar(12) NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  disabled_at timestamptz,
  created_by uuid NOT NULL,
  updated_by uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  CONSTRAINT mcp_binding_principal_fk FOREIGN KEY (organization_id, principal_id)
    REFERENCES principals(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT mcp_binding_creator_fk FOREIGN KEY (organization_id,created_by)
    REFERENCES principals(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT mcp_binding_updater_fk FOREIGN KEY (organization_id,updated_by)
    REFERENCES principals(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT mcp_binding_unique_identity UNIQUE
    (oauth_issuer, oauth_subject, oauth_client_id),
  CONSTRAINT mcp_binding_issuer_syntax CHECK
    (oauth_issuer ~ '^https://' AND oauth_issuer !~ '[[:cntrl:]]'),
  CONSTRAINT mcp_binding_subject_nonempty CHECK
    (length(btrim(oauth_subject)) BETWEEN 1 AND 512),
  CONSTRAINT mcp_binding_client_nonempty CHECK
    (length(btrim(oauth_client_id)) BETWEEN 1 AND 256),
  CONSTRAINT mcp_binding_valid_scopes CHECK
    (cardinality(allowed_scopes) BETWEEN 1 AND 64),
  CONSTRAINT mcp_binding_status CHECK (status IN ('active','disabled')),
  CONSTRAINT mcp_binding_revision_positive CHECK (revision >= 1),
  CONSTRAINT mcp_binding_disabled_timestamp CHECK
    ((status='active' AND disabled_at IS NULL) OR
     (status='disabled' AND disabled_at IS NOT NULL))
);
CREATE INDEX mcp_bindings_tenant_idx ON mcp_principal_bindings
  (organization_id,principal_id,status);

ALTER TABLE mcp_principal_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_principal_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY mcp_bindings_app_tenant ON mcp_principal_bindings
  FOR SELECT TO fad_app USING
  (organization_id = nullif(current_setting('fad.org_id',true),'')::uuid);
-- Only no-login SECURITY DEFINER reader can resolve the pre-tenant identity.
CREATE POLICY mcp_bindings_lookup_reader ON mcp_principal_bindings
  FOR SELECT TO fad_mcp_auth_reader USING (true);
-- Provision through the Slice 0 offline bootstrap role (not HTTP or MCP).
CREATE POLICY mcp_bindings_bootstrap ON mcp_principal_bindings
  FOR ALL TO fad_bootstrap USING (true) WITH CHECK (true);
REVOKE ALL ON mcp_principal_bindings FROM PUBLIC;
-- Do NOT grant direct SELECT to fad_app: pre-tenant lookup uses function.
GRANT SELECT ON mcp_principal_bindings TO fad_mcp_auth_reader;
GRANT SELECT,INSERT,UPDATE ON mcp_principal_bindings TO fad_bootstrap;

CREATE FUNCTION fad_lookup_mcp_principal(
  p_issuer text,
  p_subject text,
  p_client_id text
)
RETURNS TABLE (
  organization_id uuid,
  principal_id uuid,
  allowed_scopes text[],
  binding_status text,
  binding_revision bigint
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT b.organization_id, b.principal_id, b.allowed_scopes,
         b.status::text, b.revision
  FROM public.mcp_principal_bindings AS b
  WHERE b.oauth_issuer = p_issuer
    AND b.oauth_subject = p_subject
    AND b.oauth_client_id = p_client_id
  LIMIT 1
$function$;
ALTER FUNCTION fad_lookup_mcp_principal(text,text,text)
  OWNER TO fad_mcp_auth_reader;
REVOKE ALL ON FUNCTION fad_lookup_mcp_principal(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fad_lookup_mcp_principal(text,text,text) TO fad_app;

-- Requirements enforced in service, with same tenant context as Slice 0:
-- (1) JWT issuer/audience/signature/expiry validated before function call.
-- (2) org.status and principal.status rechecked each request under SET LOCAL.
-- (3) token scopes intersect binding scopes AND existing operation scopes.
-- (4) no tenant/client/issuer/subject is accepted from MCP tool arguments.
-- (5) bootstrap changes audited via existing audit_events in SAME transaction.
-- (6) no destructive delete; disable binding to revoke MCP access.
-- Runner writes schema_migrations checksum in the same transaction.
