-- Federated Agent Directory Slice 5: policy definition, revision, and evaluation records.
-- PostgreSQL 16+; requires applied Slice 0 through 4.
-- Migration runner MUST take advisory migration lock, open ONE transaction, execute
-- SQL and insert the actual file checksum into schema_migrations, then COMMIT.
-- Run using privileged migrator, NOT fad_app; NEVER deploy on application startup.
-- No ALTER statements affect preexisting schema or API behavior.

CREATE TABLE fad_policies (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  name varchar(160) NOT NULL,
  description varchar(2000) NOT NULL DEFAULT '',
  effect text NOT NULL,
  actions text[] NOT NULL,
  subjects jsonb NOT NULL,
  resource_selector jsonb NOT NULL,
  contains_restricted_tags boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'draft',
  revision bigint NOT NULL DEFAULT 1,
  supersedes_policy_id uuid NULL,
  created_by uuid NOT NULL,
  updated_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  activated_at timestamptz NULL,
  disabled_at timestamptz NULL,
  PRIMARY KEY (organization_id, id),
  CONSTRAINT fad_policy_actor_created_fk FOREIGN KEY (organization_id,created_by)
    REFERENCES principals(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT fad_policy_actor_updated_fk FOREIGN KEY (organization_id,updated_by)
    REFERENCES principals(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT fad_policy_supersedes_fk FOREIGN KEY (organization_id,supersedes_policy_id)
    REFERENCES fad_policies(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT fad_policy_not_self_supersede CHECK (supersedes_policy_id IS NULL OR supersedes_policy_id <> id),
  CONSTRAINT fad_policy_name_valid CHECK (char_length(btrim(name)) BETWEEN 1 AND 160),
  CONSTRAINT fad_policy_effect_valid CHECK (effect IN ('allow','deny')),
  CONSTRAINT fad_policy_status_valid CHECK (status IN ('draft','active','disabled')),
  CONSTRAINT fad_policy_revision_valid CHECK (revision >= 1),
  CONSTRAINT fad_policy_actions_nonempty CHECK (cardinality(actions) BETWEEN 1 AND 5),
  CONSTRAINT fad_policy_actions_values CHECK (
    actions <@ ARRAY['agent.read','agent.discover','agent.invoke','agent.update','agent.suspend']::text[]),
  CONSTRAINT fad_policy_subjects_obj CHECK (jsonb_typeof(subjects) = 'object'),
  CONSTRAINT fad_policy_resource_obj CHECK (jsonb_typeof(resource_selector) = 'object'),
  CONSTRAINT fad_policy_valid_status_times CHECK (
    (status='draft' AND activated_at IS NULL AND disabled_at IS NULL) OR
    (status='active' AND activated_at IS NOT NULL AND disabled_at IS NULL) OR
    (status='disabled' AND activated_at IS NOT NULL AND disabled_at IS NOT NULL)),
  CONSTRAINT fad_policy_time_order CHECK (updated_at >= created_at AND
    (activated_at IS NULL OR activated_at >= created_at) AND
    (disabled_at IS NULL OR (activated_at IS NOT NULL AND disabled_at >= activated_at)))
);

-- Defense in depth: compute restricted visibility from authoritative tag definitions,
-- refuse mutation of live policy logic and enforce monotonically increasing revision.
-- App-level validation still checks full schemas, issuer authority and nested bounds.
CREATE FUNCTION fad_policy_validate_mutation() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER AS $fn$
DECLARE clause jsonb;
DECLARE def_governed boolean;
DECLARE def_visibility text;
DECLARE is_restricted boolean := false;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.revision <> 1 OR
       NEW.activated_at IS NOT NULL OR NEW.disabled_at IS NOT NULL THEN
      RAISE EXCEPTION 'new policy must start as draft revision 1' USING ERRCODE='23514';
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.organization_id <> OLD.organization_id OR NEW.id <> OLD.id OR
       NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at OR
       NEW.revision <> OLD.revision + 1 THEN
      RAISE EXCEPTION 'immutable identity or invalid policy revision' USING ERRCODE='23514';
    END IF;
    IF OLD.status = 'draft' AND NEW.status IN ('draft','active') THEN
      IF NEW.status='active' AND
        (NEW.name, NEW.description, NEW.effect, NEW.actions, NEW.subjects,
         NEW.resource_selector, NEW.supersedes_policy_id) IS DISTINCT FROM
        (OLD.name, OLD.description, OLD.effect, OLD.actions, OLD.subjects,
         OLD.resource_selector, OLD.supersedes_policy_id) THEN
        RAISE EXCEPTION 'activate must not silently change policy rules' USING ERRCODE='23514';
      END IF;
    ELSIF OLD.status='active' AND NEW.status='disabled' THEN
      IF (NEW.name, NEW.description, NEW.effect, NEW.actions, NEW.subjects,
          NEW.resource_selector, NEW.supersedes_policy_id) IS DISTINCT FROM
         (OLD.name, OLD.description, OLD.effect, OLD.actions, OLD.subjects,
          OLD.resource_selector, OLD.supersedes_policy_id) THEN
        RAISE EXCEPTION 'disable must preserve active policy rules' USING ERRCODE='23514';
      END IF;
    ELSE
      RAISE EXCEPTION 'policy lifecycle transition forbidden' USING ERRCODE='23514';
    END IF;
  END IF;
  IF jsonb_typeof(NEW.resource_selector -> 'tags_all')='array' THEN
    FOR clause IN SELECT value FROM jsonb_array_elements(NEW.resource_selector->'tags_all') LOOP
      IF jsonb_typeof(clause) <> 'object' OR
         NOT (clause ? 'namespace') OR NOT (clause ? 'key') THEN
        RAISE EXCEPTION 'invalid tag selector shape' USING ERRCODE='23514';
      END IF;
      SELECT td.governed, td.visibility
        INTO def_governed, def_visibility
        FROM tag_definitions td
       WHERE td.organization_id=NEW.organization_id
         AND td.namespace=clause->>'namespace' AND td.tag_key=clause->>'key';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'unknown tag definition' USING ERRCODE='23503';
      END IF;
      is_restricted := is_restricted OR def_governed OR (def_visibility='restricted');
    END LOOP;
  END IF;
  NEW.contains_restricted_tags := is_restricted;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER fad_policy_guard
  BEFORE INSERT OR UPDATE ON fad_policies
  FOR EACH ROW EXECUTE FUNCTION fad_policy_validate_mutation();

CREATE INDEX fad_policy_active_lookup ON fad_policies
  (organization_id,effect,id) WHERE status='active';
CREATE INDEX fad_policy_list_idx ON fad_policies
  (organization_id,created_at DESC,id DESC);
CREATE INDEX fad_policy_supersedes_idx ON fad_policies
  (organization_id,supersedes_policy_id) WHERE supersedes_policy_id IS NOT NULL;
-- Optional GIN index deferred until measurement proves benefit; active count is bounded to 256.

CREATE TABLE fad_policy_revisions (
  organization_id uuid NOT NULL,
  policy_id uuid NOT NULL,
  revision bigint NOT NULL,
  operation text NOT NULL,
  snapshot jsonb NOT NULL,
  actor_principal_id uuid NOT NULL,
  happened_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (organization_id,policy_id,revision),
  CONSTRAINT fad_policy_rev_parent_fk FOREIGN KEY (organization_id,policy_id)
    REFERENCES fad_policies(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT fad_policy_rev_actor_fk FOREIGN KEY (organization_id,actor_principal_id)
    REFERENCES principals(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT fad_policy_rev_operation CHECK (operation IN ('created','draft_updated','activated','disabled')),
  CONSTRAINT fad_policy_rev_snapshot_object CHECK (jsonb_typeof(snapshot)='object'),
  CONSTRAINT fad_policy_rev_positive CHECK (revision >= 1)
);
CREATE INDEX fad_policy_history_time_idx ON fad_policy_revisions
  (organization_id,policy_id,happened_at DESC);

CREATE TABLE fad_policy_decisions (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  caller_principal_id uuid NOT NULL,
  subject_principal_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  action text NOT NULL,
  decision boolean NOT NULL,
  reason_code text NOT NULL,
  policy_set_digest char(64) NOT NULL,
  input_digest char(64) NOT NULL,
  agent_revision bigint NOT NULL,
  matched_policy_count integer NOT NULL,
  request_id uuid NOT NULL,
  evaluated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (organization_id,id),
  CONSTRAINT fad_decision_caller_fk FOREIGN KEY (organization_id,caller_principal_id)
    REFERENCES principals(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT fad_decision_subject_fk FOREIGN KEY (organization_id,subject_principal_id)
    REFERENCES principals(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT fad_decision_agent_fk FOREIGN KEY (organization_id,agent_id)
    REFERENCES agents(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT fad_decision_action CHECK (
    action IN ('agent.read','agent.discover','agent.invoke','agent.update','agent.suspend')),
  CONSTRAINT fad_decision_reason CHECK (reason_code IN
    ('EXPLICIT_ALLOW','EXPLICIT_DENY','NO_MATCHING_ALLOW','SUBJECT_INACTIVE','RESOURCE_INACTIVE')),
  CONSTRAINT fad_decision_consistent CHECK (
    (decision AND reason_code='EXPLICIT_ALLOW') OR
    (NOT decision AND reason_code <> 'EXPLICIT_ALLOW')),
  CONSTRAINT fad_decision_digest_format CHECK (
    policy_set_digest ~ '^[a-f0-9]{64}$' AND input_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT fad_decision_agent_revision CHECK (agent_revision >= 1),
  CONSTRAINT fad_decision_match_count CHECK (matched_policy_count >= 0)
);
CREATE INDEX fad_decision_time_idx ON fad_policy_decisions
  (organization_id,evaluated_at DESC,id DESC);
CREATE INDEX fad_decision_subject_idx ON fad_policy_decisions
  (organization_id,subject_principal_id,evaluated_at DESC);
CREATE INDEX fad_decision_request_idx ON fad_policy_decisions
  (organization_id,request_id);

-- Tenant RLS must fail closed when fad.org_id is unset or invalid.
-- App MUST also use org predicates and tenant-scoped transactions.
ALTER TABLE fad_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE fad_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY fad_policy_tenant ON fad_policies FOR ALL TO fad_app
  USING (organization_id = nullif(current_setting('fad.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('fad.org_id',true),'')::uuid);
ALTER TABLE fad_policy_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE fad_policy_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY fad_policy_rev_tenant ON fad_policy_revisions FOR ALL TO fad_app
  USING (organization_id = nullif(current_setting('fad.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('fad.org_id',true),'')::uuid);
ALTER TABLE fad_policy_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE fad_policy_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY fad_policy_decision_tenant ON fad_policy_decisions FOR ALL TO fad_app
  USING (organization_id = nullif(current_setting('fad.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('fad.org_id',true),'')::uuid);

REVOKE ALL ON fad_policies, fad_policy_revisions, fad_policy_decisions FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON fad_policies TO fad_app;
GRANT SELECT,INSERT ON fad_policy_revisions TO fad_app;
GRANT SELECT,INSERT ON fad_policy_decisions TO fad_app;
-- fad_app has NO DELETE privilege on any of these tables,
-- NO UPDATE/DELETE on revisions or decisions, NO BYPASSRLS.
-- Do NOT grant direct access to MCP clients; they use tenant-checked services.
-- Runner records version/checksum in the existing schema_migrations table atomically.
