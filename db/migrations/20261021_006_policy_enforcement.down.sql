DROP POLICY IF EXISTS fad_s6_agent_pep_generation ON agents;
-- DESTRUCTIVE DEVELOPMENT-ONLY DOWN MIGRATION. NEVER run while tenant enforcement
-- is ENFORCE or SHADOW or while audit evidence must be retained.
-- Normal production rollback is a code/feature rollback AFTER disabling enforcement.
DROP TRIGGER IF EXISTS fad_s6_tag_change_guard ON agent_tag_assignments;
DROP FUNCTION IF EXISTS fad_s6_tag_change_fence();
DROP TRIGGER IF EXISTS fad_s6_policy_change_guard ON fad_policies;
DROP FUNCTION IF EXISTS fad_s6_policy_change_fence();
DROP TRIGGER IF EXISTS fad_s6_config_guard ON fad_enforcement_configs;
DROP FUNCTION IF EXISTS fad_s6_validate_config();
DROP TABLE IF EXISTS fad_enforcement_decisions;
DROP TABLE IF EXISTS fad_enforcement_preflights;
DROP TABLE IF EXISTS fad_enforcement_config_revisions;
DROP TABLE IF EXISTS fad_enforcement_configs;
DROP FUNCTION IF EXISTS fad_s6_enforcement_key(uuid);
