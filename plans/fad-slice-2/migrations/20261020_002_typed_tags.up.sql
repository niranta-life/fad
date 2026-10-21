-- FAD Slice 2: typed tags. PostgreSQL 16+.
-- Apply by privileged migrator using the Slice 0 checksum/lock migration runner.
-- One transaction INCLUDING schema_migrations version/checksum insertion.
-- Never execute as fad_app. Slice 0 and Slice 1 must already be deployed.
-- The migration runner owns BEGIN/COMMIT and inserts checksum atomically.

CREATE TABLE tag_definitions (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  namespace varchar(40) NOT NULL,
  tag_key varchar(40) NOT NULL,
  value_type text NOT NULL,
  enum_values text[] NULL,
  governed boolean NOT NULL DEFAULT false,
  visibility text NOT NULL DEFAULT 'internal',
  description varchar(500) NOT NULL DEFAULT '',
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (organization_id, namespace, tag_key),
  CONSTRAINT tag_definitions_actor_fk FOREIGN KEY (organization_id,created_by)
    REFERENCES principals(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT tag_definitions_namespace_valid CHECK (namespace ~ '^[a-z][a-z0-9_-]{0,39}$'),
  CONSTRAINT tag_definitions_key_valid CHECK (tag_key ~ '^[a-z][a-z0-9_-]{0,39}$'),
  CONSTRAINT tag_definitions_type_valid CHECK (value_type IN ('string','integer','boolean','enum')),
  CONSTRAINT tag_definitions_visibility_valid CHECK (visibility IN ('internal','restricted')),
  CONSTRAINT tag_definitions_reserved_namespace CHECK (
     namespace NOT IN ('security','compliance','system') OR (governed AND visibility = 'restricted')
  ),
  CONSTRAINT tag_definitions_governed_restricted CHECK (NOT governed OR visibility = 'restricted'),
  CONSTRAINT tag_definitions_enum_values_valid CHECK (
    CASE WHEN value_type = 'enum' THEN
      enum_values IS NOT NULL AND cardinality(enum_values) BETWEEN 2 AND 32
      AND array_position(enum_values, NULL) IS NULL
    ELSE enum_values IS NULL END
  )
);

-- Defense-in-depth: enum values are unique and fit the application contract.
CREATE FUNCTION fad_validate_tag_definition() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE v text;
BEGIN
  IF NEW.value_type = 'enum' THEN
    IF (SELECT count(DISTINCT elem.val) FROM unnest(NEW.enum_values) AS elem(val))
       <> cardinality(NEW.enum_values) THEN
      RAISE EXCEPTION 'duplicate enum value' USING ERRCODE = '23514';
    END IF;
    FOREACH v IN ARRAY NEW.enum_values LOOP
      IF char_length(v) < 1 OR char_length(v) > 64 OR v !~ '^[^[:cntrl:]]+$' THEN
        RAISE EXCEPTION 'invalid enum value' USING ERRCODE = '23514';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER validate_tag_definition BEFORE INSERT ON tag_definitions
FOR EACH ROW EXECUTE FUNCTION fad_validate_tag_definition();

CREATE TABLE agent_tag_assignments (
  organization_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  namespace varchar(40) NOT NULL,
  tag_key varchar(40) NOT NULL,
  tag_value jsonb NULL,
  is_deleted boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 1,
  created_by uuid NOT NULL,
  updated_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (organization_id, agent_id, namespace, tag_key),
  CONSTRAINT agent_tag_agent_fk FOREIGN KEY (organization_id,agent_id)
    REFERENCES agents(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT agent_tag_definition_fk FOREIGN KEY (organization_id,namespace,tag_key)
    REFERENCES tag_definitions(organization_id,namespace,tag_key) ON DELETE RESTRICT,
  CONSTRAINT agent_tag_creator_fk FOREIGN KEY (organization_id,created_by)
    REFERENCES principals(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT agent_tag_updater_fk FOREIGN KEY (organization_id,updated_by)
    REFERENCES principals(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT agent_tag_revision_positive CHECK (revision >= 1),
  CONSTRAINT agent_tag_tombstone CHECK (
    (is_deleted AND tag_value IS NULL) OR
    (NOT is_deleted AND tag_value IS NOT NULL AND jsonb_typeof(tag_value) IN ('string','number','boolean'))
  )
);

-- The trigger checks value types in PostgreSQL too. The API additionally
-- validates Unicode NFC, number bounds and shape before entering a transaction.
CREATE FUNCTION fad_validate_agent_tag_value() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE def tag_definitions%ROWTYPE;
DECLARE txt text;
BEGIN
  IF NEW.is_deleted THEN RETURN NEW; END IF;
  SELECT * INTO def FROM tag_definitions
   WHERE organization_id = NEW.organization_id
     AND namespace = NEW.namespace AND tag_key = NEW.tag_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tag definition unavailable in tenant' USING ERRCODE = '23503';
  END IF;
  txt := NEW.tag_value #>> '{}';
  IF def.value_type IN ('string','enum') THEN
    IF jsonb_typeof(NEW.tag_value) <> 'string'
       OR char_length(txt) < 1 OR char_length(txt) > 128
       OR txt ~ '[[:cntrl:]]' THEN
      RAISE EXCEPTION 'invalid tag string' USING ERRCODE = '23514';
    END IF;
    IF def.value_type = 'enum' AND NOT (txt = ANY(def.enum_values)) THEN
      RAISE EXCEPTION 'invalid tag enum' USING ERRCODE = '23514';
    END IF;
  ELSIF def.value_type = 'boolean' THEN
    IF jsonb_typeof(NEW.tag_value) <> 'boolean' THEN
      RAISE EXCEPTION 'invalid tag boolean' USING ERRCODE = '23514';
    END IF;
  ELSIF def.value_type = 'integer' THEN
    IF jsonb_typeof(NEW.tag_value) <> 'number'
       OR txt !~ '^-?(0|[1-9][0-9]*)$' OR length(txt) > 12 THEN
      RAISE EXCEPTION 'invalid tag integer' USING ERRCODE = '23514';
    END IF;
    IF txt::numeric < -1000000000 OR txt::numeric > 1000000000 THEN
      RAISE EXCEPTION 'tag integer out of bounds' USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'unsupported tag type' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER validate_agent_tag_value
BEFORE INSERT OR UPDATE OF tag_value,is_deleted ON agent_tag_assignments
FOR EACH ROW EXECUTE FUNCTION fad_validate_agent_tag_value();

-- Value equality index for bounded AND/EXISTS search. Tenant first.
CREATE INDEX agent_tag_match_idx ON agent_tag_assignments
  (organization_id, namespace, tag_key, tag_value, agent_id)
  WHERE is_deleted = false;
CREATE INDEX agent_tag_by_agent_idx ON agent_tag_assignments
  (organization_id,agent_id) WHERE is_deleted = false;

CREATE TABLE agent_tag_assignment_revisions (
  organization_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  namespace varchar(40) NOT NULL,
  tag_key varchar(40) NOT NULL,
  revision bigint NOT NULL,
  operation text NOT NULL,
  previous_value jsonb NULL,
  new_value jsonb NULL,
  actor_principal_id uuid NOT NULL,
  reason varchar(500) NULL,
  happened_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (organization_id,agent_id,namespace,tag_key,revision),
  CONSTRAINT agent_tag_history_assignment_fk
    FOREIGN KEY (organization_id,agent_id,namespace,tag_key)
    REFERENCES agent_tag_assignments(organization_id,agent_id,namespace,tag_key) ON DELETE RESTRICT,
  CONSTRAINT agent_tag_history_actor_fk FOREIGN KEY (organization_id,actor_principal_id)
    REFERENCES principals(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT agent_tag_history_revision_positive CHECK (revision >= 1),
  CONSTRAINT agent_tag_history_operation_valid CHECK (operation IN ('assigned','updated','deleted')),
  CONSTRAINT agent_tag_history_value_valid CHECK (
    (operation = 'deleted' AND new_value IS NULL) OR
    (operation IN ('assigned','updated') AND new_value IS NOT NULL)
  )
);
CREATE INDEX agent_tag_history_time_idx ON agent_tag_assignment_revisions
  (organization_id,agent_id,happened_at DESC);

ALTER TABLE tag_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tag_definitions FORCE ROW LEVEL SECURITY;
CREATE POLICY tag_definitions_tenant ON tag_definitions FOR ALL TO fad_app
  USING (organization_id = nullif(current_setting('fad.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('fad.org_id',true),'')::uuid);

ALTER TABLE agent_tag_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_tag_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_tag_assignments_tenant ON agent_tag_assignments FOR ALL TO fad_app
  USING (organization_id = nullif(current_setting('fad.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('fad.org_id',true),'')::uuid);

ALTER TABLE agent_tag_assignment_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_tag_assignment_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_tag_history_tenant ON agent_tag_assignment_revisions FOR ALL TO fad_app
  USING (organization_id = nullif(current_setting('fad.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('fad.org_id',true),'')::uuid);

REVOKE ALL ON tag_definitions, agent_tag_assignments, agent_tag_assignment_revisions FROM PUBLIC;
GRANT SELECT,INSERT ON tag_definitions TO fad_app;
GRANT SELECT,INSERT,UPDATE ON agent_tag_assignments TO fad_app;
GRANT SELECT,INSERT ON agent_tag_assignment_revisions TO fad_app;
-- No DELETE rights. No UPDATE on definitions or immutable history.
-- No grants to anonymous roles. No BYPASSRLS runtime grants.

-- Migration runner inserts schema_migrations record then COMMITs.
