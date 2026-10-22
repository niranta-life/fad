-- Federated Agent Directory Slice 7, PostgreSQL 16+.
-- Execute under locked, checksummed migrator transaction, NEVER as fad_app.
-- Inspect deployed Slice 0-6 schema/role names before running. ADDITIVE ONLY.

CREATE TABLE fad_event_streams (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE RESTRICT,
  last_sequence bigint NOT NULL DEFAULT 0,
  min_retained_sequence bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT fad_s7_stream_seq CHECK (last_sequence>=0 AND min_retained_sequence BETWEEN 1 AND last_sequence+1)
);

CREATE TABLE fad_outbox_events (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  event_id uuid NOT NULL,
  sequence bigint NOT NULL,
  event_type varchar(120) NOT NULL,
  subject varchar(256) NOT NULL,
  aggregate_type varchar(40) NOT NULL,
  aggregate_id uuid NULL,
  aggregate_revision bigint NULL,
  visibility varchar(16) NOT NULL,
  payload jsonb NOT NULL,
  request_id uuid NULL,
  occurred_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (organization_id,event_id),
  CONSTRAINT fad_s7_outbox_seq_unique UNIQUE (organization_id,sequence),
  CONSTRAINT fad_s7_outbox_stream_fk FOREIGN KEY (organization_id)
    REFERENCES fad_event_streams(organization_id) ON DELETE RESTRICT,
  CONSTRAINT fad_s7_outbox_seq CHECK (sequence>0),
  CONSTRAINT fad_s7_outbox_visibility CHECK (visibility IN ('standard','restricted')),
  CONSTRAINT fad_s7_outbox_type_len CHECK (length(event_type) BETWEEN 12 AND 120),
  CONSTRAINT fad_s7_outbox_subject_len CHECK (length(subject) BETWEEN 1 AND 256),
  CONSTRAINT fad_s7_outbox_aggregate_rev CHECK (aggregate_revision IS NULL OR aggregate_revision > 0),
  CONSTRAINT fad_s7_outbox_payload_object CHECK (jsonb_typeof(payload)='object'),
  CONSTRAINT fad_s7_outbox_payload_bound CHECK (octet_length(payload::text) <= 8192)
);
CREATE INDEX fad_s7_outbox_org_type_seq ON fad_outbox_events (organization_id,event_type,sequence);
CREATE INDEX fad_s7_outbox_aggregate ON fad_outbox_events (organization_id,aggregate_type,aggregate_id,sequence DESC);
CREATE INDEX fad_s7_outbox_age ON fad_outbox_events (occurred_at,organization_id,sequence);

CREATE TABLE fad_event_subscriptions (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  owner_principal_id uuid NOT NULL,
  callback_url varchar(2048) NOT NULL,
  description varchar(256) NOT NULL DEFAULT '',
  event_types text[] NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'pending_verification',
  revision bigint NOT NULL DEFAULT 1,
  start_after_sequence bigint NULL,
  challenge_digest bytea NULL,
  challenge_ciphertext bytea NULL,
  challenge_expires_at timestamptz NULL,
  verification_attempts integer NOT NULL DEFAULT 0,
  verified_at timestamptz NULL,
  delivery_lease_owner varchar(128) NULL,
  delivery_lease_token uuid NULL,
  delivery_lease_until timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (organization_id,id),
  CONSTRAINT fad_s7_sub_owner_fk FOREIGN KEY (organization_id,owner_principal_id)
    REFERENCES principals(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT fad_s7_sub_types CHECK (cardinality(event_types) BETWEEN 1 AND 20 AND array_position(event_types,NULL) IS NULL),
  CONSTRAINT fad_s7_sub_status CHECK (status IN ('pending_verification','active','paused','disabled')),
  CONSTRAINT fad_s7_sub_revision CHECK (revision >=1),
  CONSTRAINT fad_s7_sub_watermark CHECK (start_after_sequence IS NULL OR start_after_sequence>=0),
  CONSTRAINT fad_s7_sub_challenge_length CHECK (challenge_digest IS NULL OR octet_length(challenge_digest)=32),
  CONSTRAINT fad_s7_sub_challenge_cipher CHECK (challenge_ciphertext IS NULL OR octet_length(challenge_ciphertext) BETWEEN 32 AND 256),
  CONSTRAINT fad_s7_sub_attempts CHECK (verification_attempts BETWEEN 0 AND 20),
  CONSTRAINT fad_s7_sub_verified_consistency CHECK (status IN ('pending_verification','disabled') OR (verified_at IS NOT NULL AND start_after_sequence IS NOT NULL)),
  CONSTRAINT fad_s7_sub_url_scheme CHECK (callback_url LIKE 'https://%'),
  CONSTRAINT fad_s7_sub_delivery_lease_consistency CHECK (
    (delivery_lease_owner IS NULL AND delivery_lease_token IS NULL AND delivery_lease_until IS NULL)
    OR (delivery_lease_owner IS NOT NULL AND delivery_lease_token IS NOT NULL AND delivery_lease_until IS NOT NULL))
);
CREATE INDEX fad_s7_sub_fanout ON fad_event_subscriptions(organization_id,status,id)
  WHERE status='active';
CREATE INDEX fad_s7_sub_owner ON fad_event_subscriptions(organization_id,owner_principal_id,status);

CREATE TABLE fad_webhook_secrets (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  subscription_id uuid NOT NULL,
  secret_version integer NOT NULL,
  ciphertext bytea NOT NULL,
  kms_key_ref varchar(256) NOT NULL,
  status varchar(16) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  retire_after timestamptz NULL,
  PRIMARY KEY (organization_id,id),
  CONSTRAINT fad_s7_secret_sub_fk FOREIGN KEY (organization_id,subscription_id)
    REFERENCES fad_event_subscriptions(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT fad_s7_secret_version_unique UNIQUE (organization_id,subscription_id,secret_version),
  CONSTRAINT fad_s7_secret_status CHECK (status IN ('active','overlap','retired')),
  CONSTRAINT fad_s7_secret_version CHECK (secret_version>=1),
  CONSTRAINT fad_s7_secret_notempty CHECK (octet_length(ciphertext)>=32),
  CONSTRAINT fad_s7_secret_retire CHECK (retire_after IS NULL OR retire_after>created_at)
);
CREATE UNIQUE INDEX fad_s7_secret_one_active ON fad_webhook_secrets(organization_id,subscription_id)
  WHERE status='active';

-- Only used to authorize reconstruction of one-time secret provisioning on a
-- retried identical, authenticated Idempotency-Key. Stores NO PLAINTEXT SECRET.
CREATE TABLE fad_event_secret_receipts (
  organization_id uuid NOT NULL,
  owner_principal_id uuid NOT NULL,
  receipt_key varchar(128) NOT NULL,
  operation_kind varchar(32) NOT NULL,
  subscription_id uuid NOT NULL,
  secret_id uuid NOT NULL,
  request_digest bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (organization_id,owner_principal_id,operation_kind,receipt_key),
  CONSTRAINT fad_s7_receipt_op CHECK (operation_kind IN ('create_subscription','rotate_secret')),
  CONSTRAINT fad_s7_receipt_owner_fk FOREIGN KEY (organization_id,owner_principal_id)
    REFERENCES principals(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT fad_s7_receipt_sub_fk FOREIGN KEY (organization_id,subscription_id)
    REFERENCES fad_event_subscriptions(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT fad_s7_receipt_secret_fk FOREIGN KEY (organization_id,secret_id)
    REFERENCES fad_webhook_secrets(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT fad_s7_receipt_hash_len CHECK (octet_length(request_digest)=32),
  CONSTRAINT fad_s7_receipt_window CHECK (expires_at>created_at AND expires_at<=created_at+interval '24 hours')
);
CREATE INDEX fad_s7_receipt_expiry ON fad_event_secret_receipts(expires_at);

CREATE TABLE fad_event_fanout_offsets (
  organization_id uuid PRIMARY KEY REFERENCES fad_event_streams(organization_id) ON DELETE RESTRICT,
  last_fanned_sequence bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT fad_s7_fanout_offset_nonnegative CHECK (last_fanned_sequence>=0)
);

CREATE TABLE fad_event_replay_requests (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  subscription_id uuid NOT NULL,
  from_sequence_exclusive bigint NOT NULL,
  through_sequence_inclusive bigint NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'queued',
  reason_digest bytea NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  completed_at timestamptz NULL,
  PRIMARY KEY (organization_id,id),
  CONSTRAINT fad_s7_replay_sub_fk FOREIGN KEY (organization_id,subscription_id)
    REFERENCES fad_event_subscriptions(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT fad_s7_replay_creator_fk FOREIGN KEY (organization_id,created_by)
    REFERENCES principals(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT fad_s7_replay_window CHECK (from_sequence_exclusive>=0 AND through_sequence_inclusive>from_sequence_exclusive AND through_sequence_inclusive-from_sequence_exclusive<=10000),
  CONSTRAINT fad_s7_replay_status CHECK (status IN ('queued','running','completed','failed','cancelled')),
  CONSTRAINT fad_s7_replay_digest CHECK (octet_length(reason_digest)=32)
);
CREATE INDEX fad_s7_replay_sub ON fad_event_replay_requests(organization_id,subscription_id,created_at DESC);

CREATE TABLE fad_event_delivery_jobs (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  subscription_id uuid NOT NULL,
  event_id uuid NOT NULL,
  replay_token uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000'::uuid,
  status varchar(16) NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  lease_owner varchar(128) NULL,
  lease_token uuid NULL,
  lease_expires_at timestamptz NULL,
  last_error_code varchar(80) NULL,
  last_http_status integer NULL,
  last_attempt_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (organization_id,id),
  CONSTRAINT fad_s7_job_sub_fk FOREIGN KEY (organization_id,subscription_id)
    REFERENCES fad_event_subscriptions(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT fad_s7_job_event_fk FOREIGN KEY (organization_id,event_id)
    REFERENCES fad_outbox_events(organization_id,event_id) ON DELETE RESTRICT,
  CONSTRAINT fad_s7_job_unique UNIQUE (organization_id,subscription_id,event_id,replay_token),
  CONSTRAINT fad_s7_job_attempts CHECK (attempt_count BETWEEN 0 AND 12),
  CONSTRAINT fad_s7_job_status CHECK (status IN ('pending','leased','succeeded','dead','cancelled')),
  CONSTRAINT fad_s7_job_http CHECK (last_http_status IS NULL OR last_http_status BETWEEN 100 AND 599),
  CONSTRAINT fad_s7_job_lease_consistency CHECK (
    (status='leased' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status<>'leased' AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL))
);
CREATE INDEX fad_s7_jobs_ready ON fad_event_delivery_jobs(next_attempt_at,organization_id,subscription_id)
  WHERE status IN ('pending','leased');
CREATE INDEX fad_s7_jobs_by_sub ON fad_event_delivery_jobs(organization_id,subscription_id,created_at,id);

CREATE TABLE fad_event_delivery_attempts (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  job_id uuid NOT NULL,
  attempt_number integer NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  http_status integer NULL,
  outcome varchar(24) NOT NULL,
  request_digest bytea NOT NULL,
  latency_ms integer NOT NULL,
  PRIMARY KEY (organization_id,id),
  CONSTRAINT fad_s7_attempt_job_fk FOREIGN KEY (organization_id,job_id)
    REFERENCES fad_event_delivery_jobs(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT fad_s7_attempt_number UNIQUE (organization_id,job_id,attempt_number),
  CONSTRAINT fad_s7_attempt_outcome CHECK (outcome IN ('success','transient_failure','permanent_failure','timeout','lease_lost')),
  CONSTRAINT fad_s7_attempt_http CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  CONSTRAINT fad_s7_attempt_digest CHECK (octet_length(request_digest)=32),
  CONSTRAINT fad_s7_attempt_latency CHECK (latency_ms BETWEEN 0 AND 300000),
  CONSTRAINT fad_s7_attempt_times CHECK (finished_at>=started_at)
);
CREATE INDEX fad_s7_attempt_job_time ON fad_event_delivery_attempts(organization_id,job_id,attempt_number);

-- Tenant RLS on every new tenant table; FORCE blocks table owner bypass when
-- applied to the table owner, but runtime role must also lack BYPASSRLS.
DO $block$
DECLARE table_name text;
BEGIN
 FOREACH table_name IN ARRAY ARRAY[
  'fad_event_streams','fad_outbox_events','fad_event_subscriptions',
  'fad_webhook_secrets','fad_event_secret_receipts','fad_event_fanout_offsets',
  'fad_event_replay_requests','fad_event_delivery_jobs','fad_event_delivery_attempts']
 LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
  EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO fad_app USING (organization_id=nullif(current_setting(''fad.org_id'',true),'''')::uuid) WITH CHECK (organization_id=nullif(current_setting(''fad.org_id'',true),'''')::uuid)',
    'fad_s7_' || table_name || '_tenant', table_name);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',table_name);
 END LOOP;
END $block$;

-- Runtime is only permitted narrow DML. No event/attempt UPDATE/DELETE.
GRANT SELECT,INSERT,UPDATE ON fad_event_streams TO fad_app;
GRANT SELECT,INSERT ON fad_outbox_events TO fad_app;
GRANT SELECT,INSERT,UPDATE ON fad_event_subscriptions TO fad_app;
GRANT SELECT,INSERT,UPDATE(status,retire_after) ON fad_webhook_secrets TO fad_app;
GRANT SELECT,INSERT ON fad_event_secret_receipts TO fad_app;
GRANT SELECT,INSERT,UPDATE ON fad_event_fanout_offsets TO fad_app;
GRANT SELECT,INSERT,UPDATE(status,completed_at) ON fad_event_replay_requests TO fad_app;
GRANT SELECT,INSERT,UPDATE ON fad_event_delivery_jobs TO fad_app;
GRANT SELECT,INSERT ON fad_event_delivery_attempts TO fad_app;

-- IMPORTANT: generic fad_app SELECT on fad_webhook_secrets is tenant-limited
-- but broader than desired. Ciphertext is AES-256-GCM under FAD_EVENTS_SECRET_KEY.
-- fad_app cannot UPDATE the capture flag and cannot EXECUTE prune.
-- The API session stays fad_app. It has no BYPASSRLS.

-- One global row. fad_app may read it. Only the migration role may change it.
CREATE TABLE fad_event_capture_control (
  id boolean PRIMARY KEY DEFAULT true,
  required boolean NOT NULL DEFAULT false,
  CONSTRAINT fad_s7_capture_singleton CHECK (id)
);
INSERT INTO fad_event_capture_control (id, required) VALUES (true, false);
REVOKE ALL ON fad_event_capture_control FROM PUBLIC;
GRANT SELECT ON fad_event_capture_control TO fad_app;

-- Old writers do not set fad.events_generation. When required is true, their
-- mutations fail closed. Pausing this flag does not delete events or audit rows.
CREATE FUNCTION fad_s7_writer_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM public.fad_event_capture_control WHERE required) THEN
    IF current_setting('fad.events_generation', true) IS DISTINCT FROM '7' THEN
      RAISE EXCEPTION 'event capture generation is required'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION fad_s7_writer_guard() OWNER TO fad_bootstrap;
REVOKE ALL ON FUNCTION fad_s7_writer_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fad_s7_writer_guard() TO fad_app;

DO $guard$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'agents','tag_definitions','agent_tag_assignments','capability_versions',
    'agent_endpoints','agent_capability_bindings','fad_policies','fad_enforcement_configs']
  LOOP
    -- Slice 3 tables are created by a later filename. A fresh database skips
    -- them here. 20261024_001 adds any guard that is still missing.
    IF to_regclass('public.' || target) IS NULL THEN
      CONTINUE;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'fad_s7_guard_' || target AND NOT tgisinternal) THEN
      CONTINUE;
    END IF;
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION fad_s7_writer_guard()',
      'fad_s7_guard_' || target, target);
  END LOOP;
END
$guard$;

-- Lists organization ids that have fanout, delivery, or verification work.
-- The role is NOLOGIN and is not granted to fad_app. BYPASSRLS applies only
-- inside this function. The function returns ids, not payloads or secrets.
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fad_event_dispatcher') THEN
    CREATE ROLE fad_event_dispatcher NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS;
  END IF;
END
$role$;
ALTER ROLE fad_event_dispatcher NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS;
GRANT USAGE ON SCHEMA public TO fad_event_dispatcher;
GRANT SELECT ON fad_event_streams, fad_event_fanout_offsets, fad_event_delivery_jobs, fad_event_subscriptions TO fad_event_dispatcher;

CREATE FUNCTION fad_s7_pending_orgs()
RETURNS TABLE (organization_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT s.organization_id
    FROM public.fad_event_streams AS s
    LEFT JOIN public.fad_event_fanout_offsets AS o ON o.organization_id = s.organization_id
   WHERE s.last_sequence > COALESCE(o.last_fanned_sequence, 0)
  UNION
  SELECT j.organization_id
    FROM public.fad_event_delivery_jobs AS j
   WHERE j.status IN ('pending', 'leased')
  UNION
  SELECT sub.organization_id
    FROM public.fad_event_subscriptions AS sub
   WHERE sub.status = 'pending_verification'
     AND sub.verification_attempts < 20
$function$;
ALTER FUNCTION fad_s7_pending_orgs() OWNER TO fad_event_dispatcher;
REVOKE ALL ON FUNCTION fad_s7_pending_orgs() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fad_s7_pending_orgs() TO fad_app;

-- Privileged retention. Refuses while a pending job or open replay still needs
-- the rows. Does not run on API startup and is not granted to fad_app.
CREATE FUNCTION fad_s7_prune_retained(p_org uuid, p_before bigint)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  blocked bigint;
  removed bigint;
BEGIN
  IF p_before < 1 THEN
    RAISE EXCEPTION 'retention bound is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO blocked
    FROM public.fad_event_delivery_jobs AS j
    JOIN public.fad_outbox_events AS e
      ON e.organization_id = j.organization_id AND e.event_id = j.event_id
   WHERE j.organization_id = p_org
     AND e.sequence < p_before
     AND j.status IN ('pending', 'leased');
  IF blocked > 0 THEN
    RAISE EXCEPTION 'pending delivery still needs retained events' USING ERRCODE = '55000';
  END IF;
  SELECT count(*) INTO blocked
    FROM public.fad_event_replay_requests
   WHERE organization_id = p_org
     AND status IN ('queued', 'running')
     AND through_sequence_inclusive >= p_before
     AND from_sequence_exclusive < p_before;
  IF blocked > 0 THEN
    RAISE EXCEPTION 'open replay still needs retained events' USING ERRCODE = '55000';
  END IF;
  DELETE FROM public.fad_event_delivery_attempts AS a
   USING public.fad_event_delivery_jobs AS j, public.fad_outbox_events AS e
   WHERE a.organization_id = j.organization_id
     AND a.job_id = j.id
     AND j.organization_id = e.organization_id
     AND j.event_id = e.event_id
     AND e.organization_id = p_org
     AND e.sequence < p_before
     AND j.status IN ('succeeded', 'dead', 'cancelled');
  DELETE FROM public.fad_event_delivery_jobs AS j
   USING public.fad_outbox_events AS e
   WHERE j.organization_id = e.organization_id
     AND j.event_id = e.event_id
     AND e.organization_id = p_org
     AND e.sequence < p_before
     AND j.status IN ('succeeded', 'dead', 'cancelled');
  DELETE FROM public.fad_outbox_events
   WHERE organization_id = p_org AND sequence < p_before;
  GET DIAGNOSTICS removed = ROW_COUNT;
  UPDATE public.fad_event_streams
     SET min_retained_sequence = GREATEST(min_retained_sequence, p_before),
         updated_at = transaction_timestamp()
   WHERE organization_id = p_org;
  RETURN removed;
END;
$function$;
ALTER FUNCTION fad_s7_prune_retained(uuid, bigint) OWNER TO fad_bootstrap;
REVOKE ALL ON FUNCTION fad_s7_prune_retained(uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fad_s7_prune_retained(uuid, bigint) TO fad_bootstrap;
