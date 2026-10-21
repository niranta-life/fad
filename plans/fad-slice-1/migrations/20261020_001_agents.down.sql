-- Development-only guarded down migration.
-- NEVER use to roll back a production deployment containing agent data.
-- Production rollback: roll back application only if schema-compatible;
-- otherwise roll forward. Restore from a verified backup only under DR plan.
BEGIN;
-- Temporarily disable RLS under an exclusive schema lock so the emptiness
-- check cannot be fooled by FORCE RLS hiding existing tenant rows.
-- If the check raises, the whole transaction rolls back and RLS is restored.
ALTER TABLE agent_lifecycle_events DISABLE ROW LEVEL SECURITY;
ALTER TABLE agent_revisions DISABLE ROW LEVEL SECURITY;
ALTER TABLE agents DISABLE ROW LEVEL SECURITY;
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM agents)
    OR EXISTS (SELECT 1 FROM agent_revisions)
    OR EXISTS (SELECT 1 FROM agent_lifecycle_events) THEN
   RAISE EXCEPTION 'Refusing to drop Slice 1 schema containing durable data';
 END IF;
END $$;
DROP TABLE agent_lifecycle_events;
DROP TABLE agent_revisions;
DROP TABLE agents;
COMMIT;
