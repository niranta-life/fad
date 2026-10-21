-- FAD Slice 1; PostgreSQL 16+ syntax. Must run as migration owner, NOT fad_app.
-- Prerequisite Slice 0: organizations(id uuid), principals(id uuid,
-- organization_id uuid), UNIQUE(principals.organization_id, principals.id),
-- fad_app database role without BYPASSRLS, and audit/idempotency infrastructure.
-- Fail deployment if prerequisites are not satisfied; do not modify Slice 0 here.
BEGIN;

CREATE TABLE agents (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  name varchar(160) NOT NULL,
  description varchar(2000) NOT NULL DEFAULT '',
  owner_principal_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active',
  revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  created_by uuid NOT NULL,
  updated_by uuid NOT NULL,
  PRIMARY KEY (organization_id, id),
  CONSTRAINT agents_name_nonblank CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  CONSTRAINT agents_status_check CHECK (status IN ('active','suspended','retired')),
  CONSTRAINT agents_revision_positive CHECK (revision >= 1),
  CONSTRAINT agents_owner_same_org FOREIGN KEY (organization_id, owner_principal_id)
    REFERENCES principals(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT agents_creator_same_org FOREIGN KEY (organization_id, created_by)
    REFERENCES principals(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT agents_updater_same_org FOREIGN KEY (organization_id, updated_by)
    REFERENCES principals(organization_id,id) ON DELETE RESTRICT
);

CREATE INDEX agents_listing_idx
  ON agents(organization_id, created_at DESC, id DESC);
CREATE INDEX agents_status_listing_idx
  ON agents(organization_id, status, created_at DESC, id DESC);
CREATE INDEX agents_owner_idx
  ON agents(organization_id, owner_principal_id);

CREATE TABLE agent_revisions (
  organization_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  revision bigint NOT NULL,
  snapshot jsonb NOT NULL,
  operation text NOT NULL,
  actor_principal_id uuid NOT NULL,
  happened_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (organization_id, agent_id, revision),
  CONSTRAINT agent_revisions_fk FOREIGN KEY (organization_id,agent_id)
    REFERENCES agents(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT agent_revisions_actor_same_org FOREIGN KEY (organization_id,actor_principal_id)
    REFERENCES principals(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT agent_revisions_valid_revision CHECK (revision >= 1),
  CONSTRAINT agent_revisions_op CHECK (operation IN
    ('registered','updated','suspended','activated','retired')),
  CONSTRAINT agent_revisions_snapshot_object CHECK (jsonb_typeof(snapshot)='object')
);

CREATE TABLE agent_lifecycle_events (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  agent_id uuid NOT NULL,
  revision bigint NOT NULL,
  from_status text NULL,
  to_status text NOT NULL,
  reason varchar(500) NULL,
  actor_principal_id uuid NOT NULL,
  happened_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (organization_id,id),
  CONSTRAINT agent_lifecycle_agent_fk FOREIGN KEY (organization_id,agent_id)
    REFERENCES agents(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT agent_lifecycle_revision_fk FOREIGN KEY (organization_id,agent_id,revision)
    REFERENCES agent_revisions(organization_id,agent_id,revision) ON DELETE RESTRICT,
  CONSTRAINT agent_lifecycle_actor_same_org FOREIGN KEY (organization_id,actor_principal_id)
    REFERENCES principals(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT agent_lifecycle_from_check CHECK (from_status IS NULL OR
    from_status IN ('active','suspended','retired')),
  CONSTRAINT agent_lifecycle_to_check CHECK
    (to_status IN ('active','suspended','retired')),
  CONSTRAINT agent_lifecycle_reason_check CHECK
    (reason IS NULL OR length(btrim(reason)) >= 1),
  CONSTRAINT agent_lifecycle_one_per_revision UNIQUE (organization_id,agent_id,revision)
);
CREATE INDEX agent_lifecycle_by_agent_idx
  ON agent_lifecycle_events(organization_id, agent_id, happened_at DESC);

-- Row-level security is a second line of defense; the service must ALSO
-- filter by authenticated organization_id on all application queries.
-- Middleware must use BEGIN; SELECT set_config('fad.org_id', :org_id, true);
-- perform DB operations on the SAME transaction connection; COMMIT/ROLLBACK.
-- The fad_app login role must not own these tables and must not have BYPASSRLS.
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents FORCE ROW LEVEL SECURITY;
CREATE POLICY agents_tenant_isolation ON agents FOR ALL TO fad_app
  USING (organization_id = nullif(current_setting('fad.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('fad.org_id',true),'')::uuid);

ALTER TABLE agent_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_revisions_tenant_isolation ON agent_revisions FOR ALL TO fad_app
  USING (organization_id = nullif(current_setting('fad.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('fad.org_id',true),'')::uuid);

ALTER TABLE agent_lifecycle_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_lifecycle_events FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_lifecycle_tenant_isolation ON agent_lifecycle_events FOR ALL TO fad_app
  USING (organization_id = nullif(current_setting('fad.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('fad.org_id',true),'')::uuid);

REVOKE ALL ON agents, agent_revisions, agent_lifecycle_events FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON agents TO fad_app;
GRANT SELECT, INSERT ON agent_revisions TO fad_app;
GRANT SELECT, INSERT ON agent_lifecycle_events TO fad_app;
-- Absolutely no DELETE privilege, and no UPDATE on immutable history tables.

COMMIT;
