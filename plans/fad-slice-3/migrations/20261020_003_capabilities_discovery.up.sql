-- Federated Agent Directory Slice 3; PostgreSQL 16+.
-- Applied by privileged migrator, in ONE transaction with schema_migrations checksum.
-- Migration runner supplies advisory lock and BEGIN/COMMIT. DO NOT run as fad_app.
-- Preconditions: Slices 0,1,2 migrations applied; organization-scoped agents,
-- principals, and tenant transaction context `fad.org_id` are available.
-- No alterations of Slices 0-2 objects or API behavior.

CREATE TABLE capability_versions (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  capability_id varchar(164) NOT NULL,
  version varchar(32) NOT NULL,
  display_name varchar(160) NOT NULL,
  description varchar(2000) NOT NULL DEFAULT '',
  input_schema jsonb NOT NULL,
  output_schema jsonb NOT NULL,
  contract_sha256 char(64) NOT NULL,
  published_by uuid NOT NULL,
  published_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (organization_id, capability_id, version),
  CONSTRAINT capability_publisher_fk FOREIGN KEY (organization_id,published_by)
     REFERENCES principals(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT capability_id_syntax CHECK (capability_id ~
    '^[a-z][a-z0-9_-]{0,39}(\.[a-z][a-z0-9_-]{0,39}){1,3}$'),
  CONSTRAINT capability_version_syntax CHECK (version ~
    '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'),
  CONSTRAINT capability_name_valid CHECK (length(btrim(display_name)) BETWEEN 1 AND 160),
  CONSTRAINT capability_schema_objects CHECK
    (jsonb_typeof(input_schema)='object' AND jsonb_typeof(output_schema)='object'),
  CONSTRAINT capability_sha256_valid CHECK (contract_sha256 ~ '^[0-9a-f]{64}$')
);
CREATE INDEX capability_versions_catalog_idx
  ON capability_versions(organization_id, capability_id, version);

-- Logical endpoints. Tombstones retain monotonically increasing revision
-- across delete/recreate; no physical deletion and no credential material.
CREATE TABLE agent_endpoints (
  organization_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  endpoint_key varchar(40) NOT NULL,
  protocol text NOT NULL,
  url varchar(2048) NOT NULL,
  auth_scheme text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  is_deleted boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 1,
  created_by uuid NOT NULL,
  updated_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (organization_id,agent_id,endpoint_key),
  CONSTRAINT endpoints_agent_fk FOREIGN KEY (organization_id,agent_id)
    REFERENCES agents(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT endpoints_creator_fk FOREIGN KEY (organization_id,created_by)
    REFERENCES principals(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT endpoints_updater_fk FOREIGN KEY (organization_id,updated_by)
    REFERENCES principals(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT endpoints_key_syntax CHECK (endpoint_key ~ '^[a-z][a-z0-9_-]{0,39}$'),
  CONSTRAINT endpoints_protocol CHECK (protocol IN ('a2a','mcp','http_json')),
  CONSTRAINT endpoints_auth_scheme CHECK (auth_scheme IN ('oauth2','mtls','api_key','none')),
  CONSTRAINT endpoints_url_scheme CHECK (url ~ '^https://'),
  CONSTRAINT endpoints_revision_positive CHECK (revision >= 1)
);
CREATE INDEX endpoints_agent_live_idx
  ON agent_endpoints(organization_id,agent_id,endpoint_key)
  WHERE is_deleted=false;

CREATE TABLE agent_endpoint_revisions (
  organization_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  endpoint_key varchar(40) NOT NULL,
  revision bigint NOT NULL,
  operation text NOT NULL,
  before_value jsonb NULL,
  after_value jsonb NULL,
  actor_principal_id uuid NOT NULL,
  happened_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (organization_id,agent_id,endpoint_key,revision),
  CONSTRAINT endpoint_revision_parent_fk FOREIGN KEY
    (organization_id,agent_id,endpoint_key)
    REFERENCES agent_endpoints(organization_id,agent_id,endpoint_key) ON DELETE RESTRICT,
  CONSTRAINT endpoint_revision_actor_fk FOREIGN KEY (organization_id,actor_principal_id)
    REFERENCES principals(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT endpoint_revision_operation CHECK
    (operation IN ('created','updated','deleted','recreated')),
  CONSTRAINT endpoint_revision_positive CHECK (revision >= 1)
);
CREATE INDEX endpoint_revision_history_idx
  ON agent_endpoint_revisions(organization_id,agent_id,happened_at DESC);

CREATE TABLE agent_capability_bindings (
  organization_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  capability_id varchar(164) NOT NULL,
  version varchar(32) NOT NULL,
  endpoint_key varchar(40) NOT NULL,
  is_deleted boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 1,
  created_by uuid NOT NULL,
  updated_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (organization_id,agent_id,capability_id),
  CONSTRAINT bindings_agent_fk FOREIGN KEY (organization_id,agent_id)
    REFERENCES agents(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT bindings_catalog_fk FOREIGN KEY (organization_id,capability_id,version)
    REFERENCES capability_versions(organization_id,capability_id,version) ON DELETE RESTRICT,
  CONSTRAINT bindings_endpoint_fk FOREIGN KEY (organization_id,agent_id,endpoint_key)
    REFERENCES agent_endpoints(organization_id,agent_id,endpoint_key) ON DELETE RESTRICT,
  CONSTRAINT bindings_creator_fk FOREIGN KEY (organization_id,created_by)
    REFERENCES principals(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT bindings_updater_fk FOREIGN KEY (organization_id,updated_by)
    REFERENCES principals(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT bindings_revision_positive CHECK (revision >= 1)
);
CREATE INDEX bindings_discovery_idx
  ON agent_capability_bindings(organization_id,capability_id,version,agent_id)
  WHERE is_deleted=false;
CREATE INDEX bindings_endpoint_usage_idx
  ON agent_capability_bindings(organization_id,agent_id,endpoint_key)
  WHERE is_deleted=false;
CREATE INDEX bindings_agent_live_idx
  ON agent_capability_bindings(organization_id,agent_id)
  WHERE is_deleted=false;

CREATE TABLE agent_capability_binding_revisions (
  organization_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  capability_id varchar(164) NOT NULL,
  revision bigint NOT NULL,
  operation text NOT NULL,
  before_value jsonb NULL,
  after_value jsonb NULL,
  actor_principal_id uuid NOT NULL,
  happened_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (organization_id,agent_id,capability_id,revision),
  CONSTRAINT binding_revision_parent_fk FOREIGN KEY
    (organization_id,agent_id,capability_id)
    REFERENCES agent_capability_bindings(organization_id,agent_id,capability_id)
    ON DELETE RESTRICT,
  CONSTRAINT binding_revision_actor_fk FOREIGN KEY (organization_id,actor_principal_id)
    REFERENCES principals(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT binding_revision_operation CHECK
    (operation IN ('created','updated','deleted','recreated')),
  CONSTRAINT binding_revision_positive CHECK (revision >= 1)
);
CREATE INDEX binding_revision_history_idx
  ON agent_capability_binding_revisions(organization_id,agent_id,happened_at DESC);

-- RLS is defense in depth; application SQL MUST also be tenant-scoped.
-- All application DB transactions must SET LOCAL fad.org_id to authenticated tenant.
ALTER TABLE capability_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE capability_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY capability_versions_tenant ON capability_versions FOR ALL TO fad_app
  USING (organization_id = nullif(current_setting('fad.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('fad.org_id',true),'')::uuid);

ALTER TABLE agent_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_endpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY endpoints_tenant ON agent_endpoints FOR ALL TO fad_app
  USING (organization_id = nullif(current_setting('fad.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('fad.org_id',true),'')::uuid);

ALTER TABLE agent_endpoint_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_endpoint_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY endpoint_revisions_tenant ON agent_endpoint_revisions FOR ALL TO fad_app
  USING (organization_id = nullif(current_setting('fad.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('fad.org_id',true),'')::uuid);

ALTER TABLE agent_capability_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_capability_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY bindings_tenant ON agent_capability_bindings FOR ALL TO fad_app
  USING (organization_id = nullif(current_setting('fad.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('fad.org_id',true),'')::uuid);

ALTER TABLE agent_capability_binding_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_capability_binding_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY binding_revisions_tenant ON agent_capability_binding_revisions FOR ALL TO fad_app
  USING (organization_id = nullif(current_setting('fad.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('fad.org_id',true),'')::uuid);

REVOKE ALL ON capability_versions, agent_endpoints, agent_endpoint_revisions,
  agent_capability_bindings, agent_capability_binding_revisions FROM PUBLIC;
GRANT SELECT, INSERT ON capability_versions TO fad_app;
GRANT SELECT, INSERT, UPDATE ON agent_endpoints TO fad_app;
GRANT SELECT, INSERT ON agent_endpoint_revisions TO fad_app;
GRANT SELECT, INSERT, UPDATE ON agent_capability_bindings TO fad_app;
GRANT SELECT, INSERT ON agent_capability_binding_revisions TO fad_app;
-- No DELETE privileges or UPDATE rights on immutable contract/revision rows.
-- Migration runner inserts schema_migrations(version,checksum_sha256) atomically.
