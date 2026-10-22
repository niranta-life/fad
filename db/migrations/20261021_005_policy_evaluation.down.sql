-- DEVELOPMENT-ONLY reverse migration.
-- Production rollback uses prior container image with expanded database kept intact.
-- DO NOT execute if any policy has been activated or decisions have been recorded:
-- history and compliance/audit evidence would be destroyed.
-- Requires privileged migration role, exclusive maintenance window, and approved
-- data export with checksum; migration runner handles version bookkeeping.
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM fad_policy_decisions) OR
     EXISTS (SELECT 1 FROM fad_policies WHERE status <> 'draft') THEN
    RAISE EXCEPTION 'unsafe destructive rollback: policy evaluation history exists';
  END IF;
END
$guard$;
DROP TABLE fad_policy_decisions;
DROP TABLE fad_policy_revisions;
DROP TABLE fad_policies;
