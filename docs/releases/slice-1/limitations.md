# Slice 1 limitations

- Directory status `active` is not permission to invoke the agent.
- Agent names are not unique inside an organization.
- There is no DELETE operation. Retire is terminal. A retired agent stays readable.
- The stored idempotency response is the response from the first commit. A later lifecycle change does not rewrite that stored response. A replay returns the stored response.
- List cursors are MAC'd with `FAD_API_KEY_PEPPER_V1`. Pepper rotation makes existing cursors invalid. The client lists again from the start.
- `fad_app` still has `DELETE` on `idempotency_records`. That grant is Slice 0. It is how an expired key is removed. `fad_app` has no `DELETE` on agent tables and no `UPDATE` on agent history.
- `fad_app` cannot lock `principals` directly. `fad_lock_principal` is `SECURITY DEFINER` and owned by `fad_bootstrap`. It only returns a row for the transaction-local organization.
- The proposal down script is not installed. Do not run it on a database that has agent rows. Roll forward, or restore a backup.
- `@fad/sdk` 0.2.0 is not published to the public npm registry.
- No CI job is configured. The CI run id is NOT RUN.
- The implementation commit id is `git --no-replace-objects rev-parse HEAD`. This commit does not copy that id into the tree. A copied id would name a different commit.
- `docker scout` was not run.
- The load sample is not a capacity test. One client sent 40 sequential `GET /v1/agents?limit=25` requests to a host Node process. PostgreSQL 16 ran in Docker. The host was Darwin arm64, 10 cores, 17179869184 bytes. All 40 responses were status 200. p50 was 4.56 ms. p95 was 5.50 ms. p99 was 10.18 ms. No latency SLO is claimed. Evidence: `api-evidence/journey.log`.
