-- FAD Slice 0 foundation. PostgreSQL 16+. Requires deploy/postgres/00_roles.sql.
-- Execute as privileged migration identity; the migration runner MUST wrap this
-- script + schema_migrations checksum INSERT in ONE transaction and migration
-- lock. This migration is NOT an API startup action.

CREATE TABLE organizations (
  id uuid PRIMARY KEY,
  name varchar(160) NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT organizations_name_nonempty CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  CONSTRAINT organizations_status_check CHECK (status IN ('active', 'suspended'))
);

CREATE TABLE principals (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  display_name varchar(160) NOT NULL,
  principal_type text NOT NULL DEFAULT 'service',
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (organization_id, id),
  CONSTRAINT principals_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT principals_name_nonblank CHECK (length(btrim(display_name)) BETWEEN 1 AND 160),
  CONSTRAINT principals_type_check CHECK (principal_type = 'service'),
  CONSTRAINT principals_status_check CHECK (status IN ('active', 'disabled'))
);

CREATE TABLE api_credentials (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  kid char(32) NOT NULL,
  principal_id uuid NOT NULL,
  verifier_hmac bytea NOT NULL,
  pepper_version smallint NOT NULL DEFAULT 1,
  scopes text[] NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  expires_at timestamptz,
  revoked_at timestamptz,
  last_rotated_at timestamptz,
  PRIMARY KEY (organization_id, id),
  CONSTRAINT api_credentials_unique_kid UNIQUE (kid),
  CONSTRAINT api_credentials_principal_same_org FOREIGN KEY (organization_id, principal_id)
    REFERENCES principals(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT api_credentials_kid_format CHECK (kid ~ '^[0-9a-f]{32}$'),
  CONSTRAINT api_credentials_digest_length CHECK (octet_length(verifier_hmac) = 32),
  CONSTRAINT api_credentials_pepper_version CHECK (pepper_version >= 1),
  CONSTRAINT api_credentials_nonempty_scopes CHECK (cardinality(scopes) >= 1),
  CONSTRAINT api_credentials_status_check CHECK (status IN ('active', 'revoked')),
  CONSTRAINT api_credentials_revocation_consistent CHECK (
    (status = 'revoked' AND revoked_at IS NOT NULL) OR
    (status = 'active' AND revoked_at IS NULL)
  ),
  CONSTRAINT api_credentials_expiry_valid CHECK (expires_at IS NULL OR expires_at > created_at)
);
CREATE INDEX api_credentials_by_principal ON api_credentials
  (organization_id,principal_id,created_at DESC);

CREATE TABLE audit_events (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  actor_principal_id uuid,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  outcome text NOT NULL,
  request_id uuid,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  happened_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (organization_id,id),
  CONSTRAINT audit_actor_same_org FOREIGN KEY (organization_id,actor_principal_id)
    REFERENCES principals(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT audit_details_object CHECK (jsonb_typeof(details)='object'),
  CONSTRAINT audit_outcome_check CHECK (outcome IN ('success','denied','failed')),
  CONSTRAINT audit_action_nonblank CHECK (length(btrim(action)) BETWEEN 1 AND 128),
  CONSTRAINT audit_target_type_nonblank CHECK (length(btrim(target_type)) BETWEEN 1 AND 80),
  CONSTRAINT audit_target_id_nonblank CHECK (length(btrim(target_id)) BETWEEN 1 AND 256)
);
CREATE INDEX audit_events_time_idx ON audit_events
  (organization_id,happened_at DESC,id DESC);
CREATE INDEX audit_events_request_idx ON audit_events
  (organization_id,request_id) WHERE request_id IS NOT NULL;

-- Infrastructure for future atomic business mutations (first consumer: Slice 1).
-- A row appears only when a business result commits, in the same transaction.
CREATE TABLE idempotency_records (
  organization_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  method varchar(8) NOT NULL,
  resource_path varchar(512) NOT NULL,
  idem_key varchar(128) NOT NULL,
  request_sha256 bytea NOT NULL,
  response_status integer NOT NULL,
  response_headers jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id,principal_id,method,resource_path,idem_key),
  CONSTRAINT idempotency_principal_same_org FOREIGN KEY (organization_id,principal_id)
    REFERENCES principals(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT idempotency_sha256_length CHECK (octet_length(request_sha256)=32),
  CONSTRAINT idempotency_method_check CHECK (method IN ('POST','PATCH','PUT','DELETE')),
  CONSTRAINT idempotency_key_nonempty CHECK (length(btrim(idem_key)) BETWEEN 1 AND 128),
  CONSTRAINT idempotency_status_check CHECK (response_status BETWEEN 200 AND 599),
  CONSTRAINT idempotency_header_object CHECK (jsonb_typeof(response_headers)='object'),
  CONSTRAINT idempotency_expiry_check CHECK (expires_at > created_at)
);
CREATE INDEX idempotency_expiry_idx ON idempotency_records(expires_at);

-- Migration runner owns version recording and checksum insertion. Do not
-- insert a fabricated checksum here; expect the runner to write it atomically.
CREATE TABLE schema_migrations (
  version varchar(80) PRIMARY KEY,
  checksum_sha256 char(64) NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT migration_checksum_hex CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$')
);

-- RLS is a second layer, not the sole tenant boundary. Fail closed without
-- `SET LOCAL fad.org_id` in the current transaction.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY organizations_tenant ON organizations FOR ALL TO fad_app
  USING (id = nullif(current_setting('fad.org_id',true),'')::uuid)
  WITH CHECK (id = nullif(current_setting('fad.org_id',true),'')::uuid);

ALTER TABLE principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE principals FORCE ROW LEVEL SECURITY;
CREATE POLICY principals_tenant ON principals FOR ALL TO fad_app
  USING (organization_id = nullif(current_setting('fad.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('fad.org_id',true),'')::uuid);

ALTER TABLE api_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY credentials_tenant ON api_credentials FOR ALL TO fad_app
  USING (organization_id = nullif(current_setting('fad.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('fad.org_id',true),'')::uuid);

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_tenant ON audit_events FOR ALL TO fad_app
  USING (organization_id = nullif(current_setting('fad.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('fad.org_id',true),'')::uuid);

ALTER TABLE idempotency_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_records FORCE ROW LEVEL SECURITY;
CREATE POLICY idempotency_tenant ON idempotency_records FOR ALL TO fad_app
  USING (organization_id = nullif(current_setting('fad.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('fad.org_id',true),'')::uuid);

REVOKE ALL ON organizations, principals, api_credentials,
  audit_events, idempotency_records, schema_migrations FROM PUBLIC;
GRANT SELECT ON organizations, principals, schema_migrations TO fad_app;
GRANT SELECT, INSERT ON audit_events TO fad_app;
GRANT SELECT, INSERT, DELETE ON idempotency_records TO fad_app;
-- Slice 1 may need INSERT/UPDATE for idempotency response staging, but it must
-- use atomic completed records; grant UPDATE only if the implementation proves
-- necessity. No blanket UPDATE privilege is granted now.
GRANT SELECT ON api_credentials TO fad_auth_reader;
GRANT SELECT,INSERT,UPDATE ON organizations, principals, api_credentials TO fad_bootstrap;
GRANT INSERT ON audit_events TO fad_bootstrap;

-- Pre-tenant lookup is exclusively through this audited, fixed-search-path
-- SECURITY DEFINER function, owned by the NOLOGIN fad_auth_reader role.
CREATE FUNCTION fad_lookup_api_credential(p_kid text)
RETURNS TABLE (
  organization_id uuid,
  principal_id uuid,
  verifier_hmac bytea,
  pepper_version smallint,
  scopes text[],
  credential_status text,
  expires_at timestamptz,
  revoked_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $function$
  SELECT c.organization_id, c.principal_id, c.verifier_hmac,
         c.pepper_version, c.scopes, c.status, c.expires_at, c.revoked_at
  FROM public.api_credentials AS c
  WHERE c.kid = p_kid
  LIMIT 1
$function$;
ALTER FUNCTION fad_lookup_api_credential(text) OWNER TO fad_auth_reader;
REVOKE ALL ON FUNCTION fad_lookup_api_credential(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fad_lookup_api_credential(text) TO fad_app;

-- The migration runner inserts version/checksum before its COMMIT.
