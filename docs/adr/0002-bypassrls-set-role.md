# ADR 0002: BYPASSRLS is not inherited; admin sets role

`fad_bootstrap` is `NOLOGIN BYPASSRLS`. PostgreSQL does not inherit `BYPASSRLS` through role membership. A LOGIN operator who is only a member of `fad_bootstrap` still has row security enforced.

Decision: every offline admin transaction runs `SET LOCAL ROLE fad_bootstrap` and then checks `current_user` is `fad_bootstrap` before any write. The API never sets this role. Local Compose uses the Postgres image superuser only as the session user for that `SET ROLE`. The application does not create a superuser and refuses to start the API when `current_user` is a superuser or has `BYPASSRLS`.

Contract check: integration tests show `fad_app.rolbypassrls` is false, and an admin write observes `current_user = fad_bootstrap`.
