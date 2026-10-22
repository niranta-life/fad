-- FAD Slice 6 policy enforcement, PostgreSQL 16+.
-- Run as privileged migrator in ONE transaction using existing checksummed/locked runner.
-- Reconcile actual deployed schema and established naming before applying.
-- DO NOT run as fad_app, DO NOT auto-apply from API startup.

CREATE TABLE fad_enforcement_configs (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE RESTRICT,
  mode text NOT NULL,
  actions text[] NOT NULL,
  revision bigint NOT NULL,
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT fad_ec_actor_fk FOREIGN KEY (organization_id,updated_by)
    REFERENCES principals(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT fad_ec_mode CHECK (mode IN ('off','shadow','enforce')),
  CONSTRAINT fad_ec_revision CHECK (revision >= 1),
  CONSTRAINT fad_ec_actions CHECK (
    (mode='off' AND cardinality(actions)=0)
    OR (mode IN ('shadow','enforce') AND cardinality(actions) BETWEEN 1 AND 4)),
  CONSTRAINT fad_ec_action_values CHECK (actions <@ ARRAY[
    'agent.read','agent.discover','agent.update','agent.suspend']::text[]),
  CONSTRAINT fad_ec_actions_not_null CHECK (array_position(actions, NULL) IS NULL)
);

CREATE TABLE fad_enforcement_config_revisions (
  organization_id uuid NOT NULL,
  revision bigint NOT NULL,
  mode text NOT NULL,
  actions text[] NOT NULL,
  actor_principal_id uuid NOT NULL,
  reason_digest char(64) NOT NULL,
  preflight_id uuid NULL,
  happened_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (organization_id,revision),
  CONSTRAINT fad_ecr_config_fk FOREIGN KEY (organization_id)
    REFERENCES fad_enforcement_configs(organization_id) ON DELETE RESTRICT,
  CONSTRAINT fad_ecr_actor_fk FOREIGN KEY (organization_id,actor_principal_id)
    REFERENCES principals(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT fad_ecr_revision_positive CHECK (revision >= 1),
  CONSTRAINT fad_ecr_mode CHECK (mode IN ('off','shadow','enforce')),
  CONSTRAINT fad_ecr_digest CHECK (reason_digest ~ '^[0-9a-f]{64}$')
);

CREATE TABLE fad_enforcement_preflights (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  actor_principal_id uuid NOT NULL,
  target_mode text NOT NULL,
  target_actions text[] NOT NULL,
  passes boolean NOT NULL,
  blockers jsonb NOT NULL DEFAULT '[]'::jsonb,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  policy_snapshot_digest char(64) NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz NULL,
  PRIMARY KEY (organization_id,id),
  CONSTRAINT fad_epf_actor_fk FOREIGN KEY (organization_id,actor_principal_id)
    REFERENCES principals(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT fad_epf_target_mode CHECK (target_mode IN ('shadow','enforce')),
  CONSTRAINT fad_epf_actions CHECK (cardinality(target_actions) BETWEEN 1 AND 4),
  CONSTRAINT fad_epf_digest CHECK (policy_snapshot_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT fad_epf_times CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '10 minutes' AND (used_at IS NULL OR used_at >= issued_at)),
  CONSTRAINT fad_epf_blockers_array CHECK (jsonb_typeof(blockers) = 'array'),
  CONSTRAINT fad_epf_warnings_array CHECK (jsonb_typeof(warnings) = 'array')
);
CREATE INDEX fad_epf_expiry_idx ON fad_enforcement_preflights
  (organization_id,expires_at) WHERE used_at IS NULL;

-- Configuration history may reference its issuing, same-tenant preflight.
ALTER TABLE fad_enforcement_config_revisions
 ADD CONSTRAINT fad_ecr_preflight_fk FOREIGN KEY (organization_id,preflight_id)
 REFERENCES fad_enforcement_preflights(organization_id,id) ON DELETE RESTRICT;

CREATE TABLE fad_enforcement_decisions (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  request_id uuid NOT NULL,
  actor_principal_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  policy_decision_id uuid NULL,
  operation_id varchar(96) NOT NULL,
  action text NOT NULL,
  channel text NOT NULL,
  mode text NOT NULL,
  outcome text NOT NULL,
  reason_code text NOT NULL,
  happened_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (organization_id,id),
  CONSTRAINT fad_ed_actor_fk FOREIGN KEY (organization_id,actor_principal_id)
    REFERENCES principals(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT fad_ed_agent_fk FOREIGN KEY (organization_id,agent_id)
    REFERENCES agents(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT fad_ed_decision_fk FOREIGN KEY (organization_id,policy_decision_id)
    REFERENCES fad_policy_decisions(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT fad_ed_action CHECK (action IN ('agent.read','agent.discover','agent.update','agent.suspend')),
  CONSTRAINT fad_ed_channel CHECK (channel IN ('rest','mcp')),
  CONSTRAINT fad_ed_mode CHECK (mode IN ('shadow','enforce')),
  CONSTRAINT fad_ed_outcome CHECK (outcome IN ('allowed','denied','would_allow','would_deny')),
  CONSTRAINT fad_ed_mode_outcome CHECK (
    (mode='enforce' AND outcome IN ('allowed','denied')) OR
    (mode='shadow' AND outcome IN ('would_allow','would_deny'))),
  CONSTRAINT fad_ed_reason CHECK (length(reason_code) BETWEEN 1 AND 80)
);
CREATE INDEX fad_ed_request_idx ON fad_enforcement_decisions
  (organization_id,request_id,happened_at);
CREATE INDEX fad_ed_actor_time_idx ON fad_enforcement_decisions
  (organization_id,actor_principal_id,happened_at DESC);
CREATE INDEX fad_ed_agent_time_idx ON fad_enforcement_decisions
  (organization_id,agent_id,happened_at DESC);

-- Single-tenant shared/exclusive fence key convention shared by API and trigger.
-- hash collisions ONLY reduce concurrency; they must never authorize cross-tenant operations.
-- ALWAYS take the fence in app services before any agent row lock or snapshot read.
CREATE FUNCTION fad_s6_enforcement_key(p_org uuid) RETURNS integer
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
 SELECT hashtext(p_org::text)
$$;

CREATE FUNCTION fad_s6_validate_config() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER AS $fn$
BEGIN
  IF (SELECT count(DISTINCT val) FROM unnest(NEW.actions) AS v(val)) <> cardinality(NEW.actions) THEN
    RAISE EXCEPTION 'duplicate enforcement action' USING ERRCODE='23514';
  END IF;
  PERFORM pg_advisory_xact_lock(6816, fad_s6_enforcement_key(NEW.organization_id));
  IF TG_OP = 'INSERT' THEN
    IF NEW.revision <> 1 THEN
      RAISE EXCEPTION 'initial enforcement revision must be 1' USING ERRCODE='23514';
    END IF;
  ELSE
    IF NEW.organization_id <> OLD.organization_id OR NEW.created_at <> OLD.created_at
       OR NEW.revision <> OLD.revision+1 THEN
      RAISE EXCEPTION 'invalid enforcement revision' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER fad_s6_config_guard
  BEFORE INSERT OR UPDATE ON fad_enforcement_configs
  FOR EACH ROW EXECUTE FUNCTION fad_s6_validate_config();

-- Defense in depth. App's policy service obtains same EXCLUSIVE lock before UPDATE.
-- Lock acquisition inside trigger is fallback protection, not a substitute for lock ordering.
CREATE FUNCTION fad_s6_policy_change_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER AS $fn$
BEGIN
 IF NEW.status IS DISTINCT FROM OLD.status THEN
  PERFORM pg_advisory_xact_lock(6816, fad_s6_enforcement_key(NEW.organization_id));
 END IF;
 RETURN NEW;
END;
$fn$;
CREATE TRIGGER fad_s6_policy_change_guard
  BEFORE UPDATE OF status ON fad_policies
  FOR EACH ROW EXECUTE FUNCTION fad_s6_policy_change_fence();

CREATE FUNCTION fad_s6_tag_change_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER AS $fn$
BEGIN
  PERFORM pg_advisory_xact_lock(6816, fad_s6_enforcement_key(NEW.organization_id));
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER fad_s6_tag_change_guard
  BEFORE INSERT OR UPDATE ON agent_tag_assignments
  FOR EACH ROW EXECUTE FUNCTION fad_s6_tag_change_fence();

-- RLS: fail closed for absent/malformed fad.org_id on every new tenant table.
ALTER TABLE fad_enforcement_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE fad_enforcement_configs FORCE ROW LEVEL SECURITY;
CREATE POLICY fad_s6_config_tenant ON fad_enforcement_configs FOR ALL TO fad_app
 USING (organization_id=nullif(current_setting('fad.org_id',true),'')::uuid)
 WITH CHECK (organization_id=nullif(current_setting('fad.org_id',true),'')::uuid);

ALTER TABLE fad_enforcement_config_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE fad_enforcement_config_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY fad_s6_config_revision_tenant ON fad_enforcement_config_revisions FOR ALL TO fad_app
 USING (organization_id=nullif(current_setting('fad.org_id',true),'')::uuid)
 WITH CHECK (organization_id=nullif(current_setting('fad.org_id',true),'')::uuid);

ALTER TABLE fad_enforcement_preflights ENABLE ROW LEVEL SECURITY;
ALTER TABLE fad_enforcement_preflights FORCE ROW LEVEL SECURITY;
CREATE POLICY fad_s6_preflight_tenant ON fad_enforcement_preflights FOR ALL TO fad_app
 USING (organization_id=nullif(current_setting('fad.org_id',true),'')::uuid)
 WITH CHECK (organization_id=nullif(current_setting('fad.org_id',true),'')::uuid);

ALTER TABLE fad_enforcement_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE fad_enforcement_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY fad_s6_decision_tenant ON fad_enforcement_decisions FOR ALL TO fad_app
 USING (organization_id=nullif(current_setting('fad.org_id',true),'')::uuid)
 WITH CHECK (organization_id=nullif(current_setting('fad.org_id',true),'')::uuid);

REVOKE ALL ON fad_enforcement_configs, fad_enforcement_config_revisions,
  fad_enforcement_preflights, fad_enforcement_decisions FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON fad_enforcement_configs TO fad_app;
GRANT SELECT,INSERT ON fad_enforcement_config_revisions TO fad_app;
GRANT SELECT,INSERT,UPDATE(used_at) ON fad_enforcement_preflights TO fad_app;
GRANT SELECT,INSERT ON fad_enforcement_decisions TO fad_app;
-- No DELETE privilege and no UPDATE on decisions/revisions.
-- Privileged migrator records checksum in schema_migrations in SAME txn.

-- Old images do not set fad.pep_generation. An enforced tenant's agents stay
-- hidden from fad_app until a Slice 6 process sets that value to 6.
-- SHADOW and tenants without a config row stay visible. A database outage
-- cannot rewrite mode, so this gate does not turn ENFORCE off.
CREATE POLICY fad_s6_agent_pep_generation ON agents AS RESTRICTIVE FOR ALL TO fad_app
USING (
  NOT EXISTS (
    SELECT 1 FROM fad_enforcement_configs cfg
    WHERE cfg.organization_id = agents.organization_id
      AND cfg.mode = 'enforce'
  )
  OR current_setting('fad.pep_generation', true) = '6'
);
