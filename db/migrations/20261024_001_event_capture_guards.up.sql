-- Applied version: 20261024_001_event_capture_guards.
-- Migration 20261021_007 sorts before the Slice 3 tables on a fresh database.
-- This file adds any writer guard that is still missing.
-- It does not drop events, audit rows, or secrets. No down script.

DO $guard$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'agents','tag_definitions','agent_tag_assignments','capability_versions',
    'agent_endpoints','agent_capability_bindings','fad_policies','fad_enforcement_configs']
  LOOP
    IF to_regclass('public.' || target) IS NULL THEN
      CONTINUE;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_trigger
       WHERE tgname = 'fad_s7_guard_' || target AND NOT tgisinternal
    ) THEN
      CONTINUE;
    END IF;
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION fad_s7_writer_guard()',
      'fad_s7_guard_' || target, target);
  END LOOP;
END
$guard$;
