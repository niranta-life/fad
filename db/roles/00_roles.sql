-- Example one-time privileged DB role setup. Run only by a DBA/admin.
-- Roles are not created by runtime containers. Review role ownership and
-- permissions in your own managed Postgres deployment.
DO $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fad_migrator') THEN
   CREATE ROLE fad_migrator NOLOGIN NOBYPASSRLS;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fad_app') THEN
   CREATE ROLE fad_app LOGIN NOBYPASSRLS;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fad_auth_reader') THEN
   CREATE ROLE fad_auth_reader NOLOGIN BYPASSRLS;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fad_bootstrap') THEN
   CREATE ROLE fad_bootstrap NOLOGIN BYPASSRLS;
 END IF;
END $$;
-- Provision password/iam for fad_app OUTSIDE THIS FILE. Set audited operator
-- memberships for migrator/bootstrap; do NOT grant either to fad_app.
-- The fad_auth_reader role has no LOGIN, and its only SELECT grant will be
-- api_credentials for the SECURITY DEFINER lookup.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO fad_app, fad_auth_reader, fad_bootstrap;
GRANT CREATE, USAGE ON SCHEMA public TO fad_migrator;
