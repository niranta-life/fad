# ADR 0006: Compose build context is the repository root

`plans/fad-slice-0/deploy/docker/compose.yaml` sets `context: ../..`, which is the package directory, not the application tree. The reference Dockerfile also omits `contracts/` and `db/`.

Decision: the runnable stack is `deploy/docker/compose.yaml` with context `../..` (repository root) and `deploy/docker/Dockerfile`. The package files stay the design reference and are not edited. Migrations run in a one-shot `migrate` service. The API process does not apply DDL.

Contract check: the shipped Compose file builds from the repository root, and a catalog snapshot taken after API startup shows no new migration row.
