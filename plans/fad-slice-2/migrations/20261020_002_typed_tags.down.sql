-- DESTRUCTIVE DEVELOPMENT-ONLY DOWN MIGRATION.
-- NEVER run automatically against production. Requires migration-owner privileges.
-- Preferred production rollback: stop new endpoints, roll forward with a correcting
-- migration, retain all definitions and tag history.
-- If data has been written, restoring a previous database snapshot requires a
-- documented recovery plan and can affect unrelated writes.
BEGIN;
DROP TABLE IF EXISTS agent_tag_assignment_revisions;
DROP TABLE IF EXISTS agent_tag_assignments;
DROP TABLE IF EXISTS tag_definitions;
DROP FUNCTION IF EXISTS fad_validate_agent_tag_value();
DROP FUNCTION IF EXISTS fad_validate_tag_definition();
COMMIT;
