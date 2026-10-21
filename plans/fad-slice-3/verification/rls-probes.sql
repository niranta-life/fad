-- RLS verification skeleton. Run only in isolated integration database.
-- Prerequisites: psql variable org_a, org_b and a test role with SET ROLE fad_app.
-- Example: psql -v org_a='<uuid A>' -v org_b='<uuid B>' -f rls-probes.sql
-- Actual test assertions and fixture setup belong in integration runner.
BEGIN;
SET LOCAL ROLE fad_app;
SELECT set_config('fad.org_id', :'org_a', true);
SELECT organization_id, capability_id, version FROM capability_versions
 WHERE organization_id = :'org_a'::uuid ORDER BY capability_id,version LIMIT 5;
-- Must return zero rows, and never leak org B data:
SELECT count(*) AS MUST_BE_ZERO FROM capability_versions
 WHERE organization_id = :'org_b'::uuid;
SELECT count(*) AS MUST_BE_ZERO FROM agent_endpoints
 WHERE organization_id = :'org_b'::uuid;
SELECT count(*) AS MUST_BE_ZERO FROM agent_capability_bindings
 WHERE organization_id = :'org_b'::uuid;
ROLLBACK;

-- Missing tenant context must hide all rows:
BEGIN;
SET LOCAL ROLE fad_app;
SELECT count(*) AS MUST_BE_ZERO FROM capability_versions;
SELECT count(*) AS MUST_BE_ZERO FROM agent_endpoints;
SELECT count(*) AS MUST_BE_ZERO FROM agent_endpoint_revisions;
SELECT count(*) AS MUST_BE_ZERO FROM agent_capability_bindings;
SELECT count(*) AS MUST_BE_ZERO FROM agent_capability_binding_revisions;
ROLLBACK;

-- Verify database role capabilities and that no table grants BYPASSRLS or
-- owner privileges to fad_app. Run under privileged test inspection role.
SELECT rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
  FROM pg_roles WHERE rolname='fad_app';
SELECT relname, relrowsecurity, relforcerowsecurity
  FROM pg_class WHERE relname IN
  ('capability_versions','agent_endpoints','agent_endpoint_revisions',
   'agent_capability_bindings','agent_capability_binding_revisions');
