# Slice 0 completion

Commit message: Build tenant-safe FAD API foundation

The commit id is the output of `git --no-replace-objects rev-parse HEAD` after this commit. This file does not store that id. No replace ref, graft, or skip-worktree bit is used.

CI job URL: not configured.

Server under test: Node v24.22.0 in `node:lts-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5`.

Image: `sha256:d2b388bf095974ce6028309c3918384c7d7b9570414c18fa0870340197fca49f`. Runtime user `node` (uid 1000), linux/arm64. Both API replicas were recreated from that image. Journey log: `api-evidence/patched-journey.log` at 2026-10-21T00:32:31Z. Org A and Org B stayed isolated. Revocation failed the issued key on both replicas. Restart kept the organization and the revoked kid. Database stop returned ready 503 `{status:not_ready}` and current 503 `DEPENDENCY_UNAVAILABLE`. Database start recovered ready 200 and the same organization. Shared rate limit returned 429 with `Retry-After` 22. Container logs contained no key, pepper, or database URL.

The same image ran the schema and SDK checks with the test files mounted and the image dist left in place. An empty migration directory exited startup before listen and made `GET /health/ready` return 503 `{status:not_ready}`. The same directory made `GET /v1/organizations/current` with a valid key return 503 `DEPENDENCY_UNAVAILABLE`. A changed `schema_migrations` checksum did the same on an already running API. Restoring the checksum returned ready 200 and current 200. SDK GET retries observed 100,200 ms and 200,400 ms at the two jitter bounds, 1000,1000 ms when `Retry-After` was 30 seconds and the cap was 1000 ms, and 2000 ms when `Retry-After` was 2 seconds inside a 2500 ms deadline. Tests 2, pass 2, fail 0, duration 3789.255183 ms. Log: `coverage/schema-and-backoff.log`.

Suite inside this image used `docker run` with image argument `sha256:d2b388bf095974ce6028309c3918384c7d7b9570414c18fa0870340197fca49f`. Resolved image id matched that argument. 6 tests, 6 pass, 0 fail, exit 0, duration 4682.179866 ms, Node v24.22.0. The image dist was not mounted. Log: `coverage/node24-suite.log`. The external SDK client was host Node v25.1.0 against this API. It installed the packed `@fad/sdk` in a separate project. Log: `sdk-evidence/sdk-external.log`.

OpenAPI file is byte-identical to the package. SHA-256 `bb5a6dc96ae93fb42ed6b69af1770cd435bba43809c8942b0702d9a748beb4cc`. Diff: `openapi-diff.md`.

Migration checksums from the restored database: `0001_foundation` `09fb08e50ca20f3c1f18a32e93c03260f476c52816a976e1754a8b34505dc463`, `0002_rate_limit` `2b8f86066af0b29968268db39ca3dd297677321339b947d46e46613f68811924`.

Load sample on this image, not an SLO: 40 requests, concurrency 8, one organization row, PostgreSQL 16 in Docker, API image `sha256:d2b388bf095974ce6028309c3918384c7d7b9570414c18fa0870340197fca49f` Node v24.22.0, client host Node v25.1.0, Darwin arm64 Mac16,10, 10 cores, 17179869184 bytes. Status 200 for all 40. Elapsed 59 ms. p50 9.82 ms. p95 22.85 ms. Availability and latency SLOs are unmeasured. Log: `coverage/load.log` and `api-evidence/patched-journey.log`.

Logical restore of a 22988-byte dump into clean PostgreSQL 16 kept 2 organizations, 2 principals, 4 credentials (3 active, 1 revoked), 9 audit rows, and both migration checksums. The revoked kid `9986cec65b63223305823f98bd54508a` survived. The first restore failed until `00_roles.sql` was applied. Log: `db-evidence/restore.log`.

WAL PITR on the same host recovered that database plus a marker row written after `pg_basebackup`. The marker string was absent from the base tar and present in the archived WAL segment. Recovered counts stayed 2, 2, 4, 9, and 2. Audit id digest matched. Archive lag 0.402 seconds. Restore-to-ready 1.942 seconds. Disaster-to-ready 2.199 seconds. Missing committed marker rows: 0. OPERATIONS.md states no numeric RPO or RTO target, so those SLOs are not claimed. Log: `db-evidence/pitr.log`.

`npm audit --omit=dev` used `docker run` with image argument `sha256:d2b388bf095974ce6028309c3918384c7d7b9570414c18fa0870340197fca49f`. Resolved image id matched that argument. The report was info 0, low 0, moderate 0, high 0, critical 0, total 0. Production dependencies 77, dev 4, optional 1, peer 0, total 81. Command log: `security-evidence/npm-audit-run.log`. JSON: `security-evidence/npm-audit.json`. Trivy 0.69.3 on this image at 2026-10-21T00:32:51Z reported critical 0, high 60, medium 92, low 84, unknown 1, and secret findings 0. CycloneDX 1.6 SBOM has 309 components. `docker scout` did not scan because the CLI is not logged in. Log: `security-evidence/trivy-run.log`.

Slice 1 agent routes are not implemented. `plans/fad-slice-1/**` and `docs/releases/slice-1/**` were not modified by this work.

| ID | Result | Evidence |
| --- | --- | --- |
| S0-A01 | pass | `by-id/S0-A01.log`. |
| S0-A02 | pass | `by-id/S0-A02.log`. |
| S0-A03 | pass | `by-id/S0-A03.log`. |
| S0-A04 | pass | `by-id/S0-A04.log`. |
| S0-A05 | pass | `by-id/S0-A05.log`. |
| S0-A06 | pass | `by-id/S0-A06.log`. |
| S0-A07 | pass | `by-id/S0-A07.log`. |
| S0-A08 | pass | `by-id/S0-A08.log`. |
| S0-A09 | pass | `by-id/S0-A09.log`. |
| S0-A10 | pass | `by-id/S0-A10.log`. |
| S0-A11 | pass | `by-id/S0-A11.log`. |
| S0-A12 | pass | `by-id/S0-A12.log`. |
| S0-A13 | pass | `by-id/S0-A13.log`. |
| S0-A14 | pass | `by-id/S0-A14.log`. |
| S0-D01 | pass | `by-id/S0-D01.log`. |
| S0-D02 | pass | `by-id/S0-D02.log`. |
| S0-D03 | pass | `by-id/S0-D03.log`. |
| S0-D04 | pass | `by-id/S0-D04.log`. |
| S0-D05 | pass | `by-id/S0-D05.log`. |
| S0-D06 | pass | `by-id/S0-D06.log`. |
| S0-D07 | pass | `by-id/S0-D07.log`. |
| S0-D08 | pass | `by-id/S0-D08.log`. |
| S0-D09 | pass | `by-id/S0-D09.log`. |
| S0-D10 | pass | `by-id/S0-D10.log`. |
| S0-D11 | pass | `by-id/S0-D11.log`. |
| S0-I01 | pass | `by-id/S0-I01.log`. |
| S0-I02 | pass | `by-id/S0-I02.log`. |
| S0-I03 | pass | `by-id/S0-I03.log`. |
| S0-I04 | pass | `by-id/S0-I04.log`. |
| S0-I05 | pass | `by-id/S0-I05.log`. |
| S0-I06 | pass | `by-id/S0-I06.log`. |
| S0-O01 | pass | `by-id/S0-O01.log`. |
| S0-O02 | pass | `by-id/S0-O02.log`. |
| S0-O03 | pass | `by-id/S0-O03.log`. |
| S0-O04 | pass | `by-id/S0-O04.log`. |
| S0-O05 | pass | `by-id/S0-O05.log`. |
| S0-O06 | pass | `by-id/S0-O06.log`. Measured archive lag 0.402 s. Measured restore-to-ready 1.942 s. Product RPO/RTO targets are not claimed. |
| S0-O07 | pass | `by-id/S0-O07.log`. |
| S0-K01 | pass | `by-id/S0-K01.log`. |
| S0-K02 | pass | `by-id/S0-K02.log`. |
| S0-K03 | pass | `by-id/S0-K03.log`. |
| S0-K04 | pass | `by-id/S0-K04.log`. |
| S0-K05 | pass | `by-id/S0-K05.log`. |
| S0-C01 | pass | `by-id/S0-C01.log`. |
| S0-C02 | pass | `by-id/S0-C02.log`. |
| S0-C03 | pass | `by-id/S0-C03.log`. |

Machine-readable index: `results.json`.
