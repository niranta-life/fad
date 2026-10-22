# Deployment proof

## Current image

Build command: `docker build -f deploy/docker/Dockerfile -t fad-api:slice6 .`

Test command: `node --test --test-concurrency=1 tests/slice6-deploy.test.mjs`

Time: 2026-10-22T06:26:47.550Z through 2026-10-22T06:27:03.606Z

Exit: 0. Duration_ms 16638.868167. Log: `deployment-evidence/image-rerun-f3a44c87.log`.

Image: `fad-api:slice6`

Image id: `sha256:f3a44c87cf53cc184600db7dc07a0e348a6256740ff3839bc7d98f838082e3fc`

Created: `2026-10-21T23:12:41.848694143-07:00`

User: `node` (uid 1000)

This image was built from this commit's runtime tree. The commit id is the output of `git --no-replace-objects rev-parse HEAD`. This blob does not copy that id. The parent is `27a3f2874e8fbaa256ac88ab982904ae2ee26cdd`. The image contains the fence-timeout fail-closed code. `packages/db/dist/enforcement.js` contains `A timeout is 503 in every mode` and does not contain `s6_skip_pep`. It also contains the row lock before the decision insert and `pg_terminate_backend`. `FAD_ENFORCEMENT_CODE_ENABLED` defaults to false. The image was not pushed to a registry.

| Check | Time | Result |
| --- | --- | --- |
| DEPLOY-FENCE | 2026-10-22T06:26:48.658Z | PASS. Phrase exit 0. `s6_skip_pep` exit 1. |
| DEPLOY-OFF | 2026-10-22T06:26:51.083Z | PASS. Mode `off`. |
| DEPLOY-FENCE-OFF | 2026-10-22T06:26:55.788Z | PASS. hold=0, held=true, read=503, tag=503, value `high`, next read 200. |
| DEPLOY-SHADOW | 2026-10-22T06:26:55.823Z | PASS. pre=200, put=200, read=200, mode `shadow`. |
| DEPLOY-ENFORCE | 2026-10-22T06:26:55.846Z | PASS. pre=200, put=200, A1 200, A2 404. |
| P25 | 2026-10-22T06:26:56.372Z | PASS. Request `b7cd95e5-905b-436f-a0ae-af85d200fdb2`. |
| T14 | 2026-10-22T06:26:56.372Z | PASS. Request `8aa20a0a-7467-4fd5-b5ce-4156ed2fcd2e`. |
| P10 | 2026-10-22T06:26:56.663Z | PASS. Request `9890e58a-a994-401b-9d90-32aaf8ed3cdf`. Suspended activate stays 403 `RESOURCE_INACTIVE`. |
| DEPLOY-OLD-IMAGE | 2026-10-22T06:26:57.499Z | PASS. Slice 5 image and flag-off image GET 404. Mode stays `enforce`. |
| DEPLOY-OUTAGE | 2026-10-22T06:27:01.710Z | PASS. Paused `fad-s0-pg`. GET 503 `DEPENDENCY_UNAVAILABLE`. Mode stays `enforce`. |
| DEPLOY-OFF-BACK | 2026-10-22T06:27:01.750Z | PASS. Audited OFF. put=200. |
| DEPLOY-PROD-BOOT | 2026-10-22T06:27:03.606Z | Refusal only. The container exited 1 against `fad-s0-pg`. The log line `PASS DEPLOY-PROD-BOOT` means the refusal check matched. It is not a live TLS pass. |

The same log also records DEPLOY-LOCK-ORDER and DEPLOY-SHUTDOWN as PASS. Migration `20261021_006_policy_enforcement` was skipped because it was already applied.

`kubectl apply` is not the Docker gate. The command result at 2026-10-22T05:39:36Z is in `kubectl.md`. No object was created.

The production TLS boot on this image passed at 2026-10-22T06:27:50Z. See `prod-tls.md` and `prod-tls-f3a44c87.log`. An earlier run of this same digest is `image-rebuild.log`, from 2026-10-22T06:13:26.723Z through 2026-10-22T06:13:44.141Z. `fad-s0-pg` still has no TLS. The 2026-10-22T05:34:55Z boot used the previous image.

CI run ID: unset.

## Previous image

Command: `node --test --test-concurrency=1 tests/slice6-deploy.test.mjs`

Time: 2026-10-22T05:16:30.396Z through 2026-10-22T05:16:41.042Z

Exit: 0. Duration_ms 11238.407583. Log: `deployment-evidence/image-rerun.log`.

Image id: `sha256:e5861d49221dc9d4598c67e521f70720f3f6a50aba4ab388fe965eff907e2473`

Created: `2026-10-21T22:11:46.062929945-07:00`

User: `node` (uid 1000)

That image does not contain the fence-timeout fail-closed code. It contains the row lock before the decision insert and `pg_terminate_backend`. It was not pushed to a registry.

| Check | Time | Result |
| --- | --- | --- |
| DEPLOY-OFF | 2026-10-22T05:16:33.199Z | PASS. Revision 0, mode `off`. |
| DEPLOY-SHADOW | 2026-10-22T05:16:33.227Z | PASS. Replica 2 returns 200 for the would-deny principal. |
| DEPLOY-ENFORCE | 2026-10-22T05:16:33.252Z | PASS. A1 200 and A2 404. |
| P25 | 2026-10-22T05:16:33.782Z | PASS. Request `3875a5a6-3a0f-4cbb-afff-8632637fbcff`. |
| T14 | 2026-10-22T05:16:33.782Z | PASS. Request `02a797e7-63a8-4b14-928b-62322dca5a22`. |
| P10 | 2026-10-22T05:16:34.080Z | PASS. Request `3d44028b-268c-4d35-ba2a-c229fc5ec61c`. Suspended activate is 403 `RESOURCE_INACTIVE`. |
| DEPLOY-OLD-IMAGE | 2026-10-22T05:16:34.996Z | PASS. Slice 5 image and flag-off image GET 404. Mode stays `enforce`. |
| DEPLOY-OUTAGE | 2026-10-22T05:16:39.224Z | PASS. Paused `fad-s0-pg`. GET 503 `DEPENDENCY_UNAVAILABLE`. Mode stays `enforce`. |
| DEPLOY-OFF-BACK | 2026-10-22T05:16:39.253Z | PASS. Audited OFF. Old image and flag-off image then GET 200. |
| DEPLOY-PROD-BOOT | 2026-10-22T05:16:41.042Z | Refusal only. The container exited 1 against `fad-s0-pg`. The log line `PASS DEPLOY-PROD-BOOT` means the refusal check matched. |

CI run ID: unset.

## Earlier image

Command: `node --test --test-concurrency=1 tests/*.test.mjs`

Test: `slice 6 image replicas, old image admission, and database outage`

Time: 2026-10-22T03:19:59.231Z through 2026-10-22T03:20:08.784Z

Exit: the suite exited 0.

Image: `fad-api:slice6`

Image id: `sha256:38d932df2039c17ed7a07b94e89e6f9de667416d9102ad4b792b845ca1c4f150`

Created: `2026-10-21T20:00:45.298980276-07:00`

User: `node` (uid 1000)

Registry digest: none. The image is a local tag.

`packages/db/dist` inside the image contains `set_config('fad.pep_generation'`.

Migrator command on the shared database: `node apps/migrator/dist/main.js up`. Result: `20261021_006_policy_enforcement` skipped because it was already applied. `FAD_APP_DB_PASSWORD` was not set, so the role password was not changed.

| Check | Time | Result |
| --- | --- | --- |
| DEPLOY-IMAGE | 2026-10-22T03:19:59.231Z | PASS |
| DEPLOY-ID | 2026-10-22T03:19:59.232Z | PASS |
| DEPLOY-GEN | 2026-10-22T03:19:59.475Z | PASS |
| DEPLOY-USER | 2026-10-22T03:19:59.669Z | PASS |
| DEPLOY-MIGRATE | 2026-10-22T03:19:59.961Z | PASS |
| DEPLOY-COMPOSE | 2026-10-22T03:20:00.173Z | PASS. Rendered compose keeps bootstrap, `read_only` true, and the enforcement flag false. |
| DEPLOY-START-18110 | 2026-10-22T03:20:00.344Z | PASS |
| DEPLOY-START-18111 | 2026-10-22T03:20:00.575Z | PASS |
| DEPLOY-READY | 2026-10-22T03:20:01.169Z | PASS. Both replicas ready. |
| DEPLOY-AGENT | 2026-10-22T03:20:01.666Z | PASS. Create 201. |
| DEPLOY-POLICY | 2026-10-22T03:20:01.716Z | PASS |
| DEPLOY-OFF | 2026-10-22T03:20:01.722Z | PASS. Revision 0, mode `off`. |
| DEPLOY-SHADOW | 2026-10-22T03:20:01.763Z | PASS. Replica 2 still returns 200 for the would-deny principal. |
| DEPLOY-ENFORCE | 2026-10-22T03:20:01.793Z | PASS. A1 200 and A2 404 on both replicas. |
| DEPLOY-OLD-START | 2026-10-22T03:20:02.719Z | PASS |
| DEPLOY-OLD-IMAGE | 2026-10-22T03:20:02.759Z | PASS. `fad-api:slice5` and flag-off `fad-api:slice6` GET 404. Mode stays `enforce`. |
| DEPLOY-OUTAGE | 2026-10-22T03:20:06.934Z | PASS. Paused `fad-s0-pg`. GET 503 `DEPENDENCY_UNAVAILABLE`. Mode stays `enforce`. |
| DEPLOY-OFF-BACK | 2026-10-22T03:20:06.959Z | PASS. Audited OFF. Old image and flag-off image then GET 200. |
| DEPLOY-PROD-BOOT | 2026-10-22T03:20:08.784Z | BLOCKED. The container exited non-zero. The log matches `sslmode` or the production TLS requirement. A live TLS boot did not run. |
| DEPLOY-PROD-NOTE | 2026-10-22T03:20:08.784Z | Local Postgres has no TLS. This earlier run did not boot on TLS. The later boot is `prod-tls-boot.log`. |

This earlier suite did not run `kubectl`. The later command is in `kubectl.md`. It is not the Docker gate.

CI run ID: unset.

The test removed its containers in `finally`. Proof containers `fad-s0-proof-api-1`, `fad-s0-proof-api-2`, and `fad-s0-restore` were not used.
