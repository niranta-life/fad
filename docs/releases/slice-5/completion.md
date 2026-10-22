# Slice 5 completion

Commit message: Add policy evaluation with safe tenant isolation

Parent: `a7b608159e4deb946bc8c9b9bc6ce19120999f98`. Diffstat: 70 files changed, 8716 insertions(+), 48 deletions(-).

Commit id: output of `git --no-replace-objects rev-parse HEAD` after this commit. This blob does not copy that id. No replace ref, graft, or skip-worktree bit is used. `plans/` stays untracked. Slice 6 is not in this commit.

CI run ID: unset. This repository has no `.github` workflows. `npm test` is not a CI run.

## What shipped

Policy drafts, activation, disable, and hypothetical decisions are available on REST and MCP when `FAD_POLICIES_ENABLED` is the exact string `true`. The image default is `false`. An allow has `enforcement` equal to `not_enforced`. It does not authorize an existing operation, issue a delegation grant, or invoke an agent.

The seven REST operations are `GET/POST /v1/policies`, `GET/PUT /v1/policies/{policyId}`, `POST /v1/policies/{policyId}/activate`, `POST /v1/policies/{policyId}/disable`, and `POST /v1/authorization/evaluate`. The seven MCP tools call the same service under the existing OAuth scope intersection. `@fad/sdk` 0.5.0 adds `policies` and `authorization.evaluate`. `@fad/mcp-client` 0.2.0 keeps the original 14 enabled tool names and adds OAuth-only helpers.

Published OpenAPI SHA-256: `43bf7c691804efac369d2166a2ec494b9a021dfbfb611122e7ced1140efb6cac`. Info version `1.5.0`. `node scripts/openapi-diff.mjs` returned `ok` true and an empty `breaking` list. Details are in `api-contract-diff.md`. MCP details are in `mcp-contract-diff.md`.

The verified image is `fad-api:slice5`, id `sha256:45fbe99e5656fdac4a3f07b703c356684c6520769bf252708ab70de122f48ba8`, created `2026-10-21T15:23:24.765703152-07:00`, user `node`, `FAD_POLICIES_ENABLED=false`. Its `packages/db/dist` contains `assertReferencedScalars` and case-normalized UUID comparison. The earlier image `sha256:a05a932ef2bbd271bd6b07b06ea778a9828dcf9ce5e1735dd41077ad4413f3b0` was created at `2026-10-21T14:44:19-07:00` and does not contain that fix. Its inspect is `deployment-evidence/image-before-match.json`.

## Environment

Host macOS arm64, Node v25.1.0. PostgreSQL 16 in container `fad-s0-pg`, published on `127.0.0.1:54329`. The suite used the workspace build. The image checks used `fad-api:slice5` and `fad-api:slice4` on Docker network `fad-s0`.

## Commands and checks

| Check | Result | Evidence |
| --- | --- | --- |
| Earlier `npm test` | PASS | 27 tests, 27 pass, 0 fail, duration_ms 71697.310834. First assertion 2026-10-21T21:44:14.207Z. `test-results/npm-test.log`. Suite stdout: `terminal/call-d21a103a-9308-44d8-86dc-2b840833ea44-130.log`. That run predates the UUID and invalid-tag checks. |
| `npm test` after the UUID and invalid-tag fix | PASS | 27 tests, 27 pass, 0 fail, duration_ms 64523.55125. First assertion 2026-10-21T22:20:25.844Z. `UUID-CASE` 2026-10-21T22:21:21.865Z. `BAD-TAG` 2026-10-21T22:21:21.916Z. `MCP` and `REQ-MCP` 2026-10-21T22:21:12.802Z. `SDK` 2026-10-21T22:21:13.869Z. `test-results/npm-test-after-match.log`. The same command also reran the historical suites, the MCP client proof, and the standalone SDK journey. |
| Frozen Slice 4 contract comparison | PASS | `test-results/baseline.log` |
| Policy compiler and decision unit | PASS | `test-results/decision-unit.log` |
| Two-organization HTTP journey | PASS | `api-evidence/journey.log`. `REQ-DRAFT` `91c907d3-9be0-4c81-bb26-2c7bab4fed1b`. `REQ-ALLOW` `1dfb40d5-add3-4a99-ac45-fd51aff67f32`. |
| Mixed-case UUID membership and invalid tag values | PASS | `UUID-CASE` and `BAD-TAG` at 2026-10-21T22:16:22Z. `test-results/uuid-tag.log`. |
| Two flag-off and two flag-on launches | PASS | `api-evidence/launch.log`. Flag on requests `dedb58f5-7778-4389-acc1-024b9c5dfd85` and `d3f2926a-dc1d-4836-a162-fca6635ea8a2`, both `allow` and `not_enforced`. |
| Separate Node `@fad/sdk` project | PASS | `sdk-evidence/sdk.log` |
| Real MCP client | PASS | `mcp-evidence/mcp.log`. `REQ-MCP` `9629a12e-8c83-42f3-9aa0-c225704b6e97`. |
| Fresh database, upgraded database, backup restore, fail-closed proofs | PASS | `test-results/proof.log` from 2026-10-21T21:43:35.796Z through 21:43:44.701Z. Stdout: `terminal/call-7f820daa-516e-4bab-89a4-d0463a3ad273-126.log`. `migration-evidence/migration.log`. |
| `node scripts/openapi-diff.mjs` | PASS | `api-evidence/openapi-diff.json` |
| Image inspect and flag-off container, including restart | PASS | Current image `deployment-evidence/image.json` and `deployment-evidence/flag-off-after-match.json`. Container `05bca081937f`. Before restart, policies 404 `2a7da6bd-cf3c-41aa-95c6-32e456c76ebb`. After restart, policies 404 `3d18485b-361d-429d-8d54-9cc37a582a85`. Earlier image smoke remains `deployment-evidence/flag-off.json`. |
| Previous image on the migrated schema | PASS | Repeated while Slice 5 was `sha256:45fbe99e5656fdac4a3f07b703c356684c6520769bf252708ab70de122f48ba8`. `deployment-evidence/previous-image-after-match.json`. Container `8515178c9f48`. Ready `fdb05d71-6684-4fbc-bf04-5963179dfe50`. Policy route `5f9c4473-bd1c-4c3f-8f15-901df69cb6b1` is 404. `fad_policies` kept. Decision rows 192. The earlier result remains `deployment-evidence/previous-image.json`. |
| Production TLS boot of the new image | BLOCKED | `deployment-evidence/production-tls-after-match.txt`. Container `1198bc0fb23e` exited 1. Local Postgres has no TLS. The earlier boot is `deployment-evidence/production-tls.txt`, container `8ef16ca67e0c`. |
| Flag-on staging on the rebuilt image | PASS | `deployment-evidence/staging-after-match.json`. Container `029c7579c850`, image `sha256:45fbe99e5656fdac4a3f07b703c356684c6520769bf252708ab70de122f48ba8`, 2026-10-21T22:29:48.634Z through 2026-10-21T22:29:50.016Z. Create `f0ed7d30-0a00-4d26-a8fc-a7a1a4a8cd48`. Activate `8dddba74-6754-46cb-a1d4-050c21074563`. Evaluate `c58b105b-c1ba-4313-9999-86d72332331e` is allow, `EXPLICIT_ALLOW`, `not_enforced`. Draft evaluate `ad38b5fa-2ac9-4d50-af90-3752d24c8a80` is deny. Uppercase ids `fd70ea35-6dd9-456f-96af-33cb3fc77ea6` are `EXPLICIT_DENY`. Tag value `1.5` `2332d0e7-c036-4e60-ba55-6c981d294ad5` is 503 and writes no decision. Revoked decision insert `f04507aa-fdd2-4d2f-a35a-6cf1cb2e85ea` is 503 and writes no decision. |
| `kubectl apply` of `deploy/k8s/policy-overlay.yaml` | BLOCKED | No cluster. The file is an overlay only. |
| Local evaluate latency, 40 sequential calls | MEASURED | Rebuilt image `sha256:45fbe99e5656fdac4a3f07b703c356684c6520769bf252708ab70de122f48ba8`, container `1fdb0186a16b`, 2026-10-21T22:33:29.425Z through 2026-10-21T22:33:31.724Z. p50 2.9 ms, p95 4.98 ms, max 5.55 ms. All 200, `allow`, `EXPLICIT_ALLOW`, `not_enforced`. `performance-evidence/evaluate-after-match.json`. First sample `4707c496-82e2-4a86-b988-eb394c4175af`. Last sample `c98d2d8f-799c-41c0-94d2-7ecc1b09c990`. The earlier sample on `sha256:a05a932e…` remains `performance-evidence/evaluate.json`. |
| CI run for this commit | NOT RUN | No workflow. Run ID unset. |

Earlier Docker build stdout: `terminal/call-3ad597e1-c235-4a87-b717-28eda8161245-129.log`. Rebuild stdout: `terminal/call-68534c11-c14f-42df-b0ce-d8978f592f15-29.log`.

Security cases are mapped in `security-evidence/checks.md`. Schema and grants are in `schema-and-rls.txt`. Limits that were not executed are in `risks-and-limitations.md`.

## Staging requests

On the rebuilt image `sha256:45fbe99e5656fdac4a3f07b703c356684c6520769bf252708ab70de122f48ba8`, container `029c7579c850`: unauthenticated policy create `8d4f5fe4-129a-4e62-abcc-80ea1cadde06` returned 401. Agent create `6d25bad8-80ee-422a-a9d8-2328f9340db0` returned 201. Policy create `f0ed7d30-0a00-4d26-a8fc-a7a1a4a8cd48` returned 201 and ETag `"policy-v1"`. Activate `8dddba74-6754-46cb-a1d4-050c21074563` returned 200 and ETag `"policy-v2"`. Evaluate `c58b105b-c1ba-4313-9999-86d72332331e` returned allow, `EXPLICIT_ALLOW`, and `not_enforced`. Draft evaluate `ad38b5fa-2ac9-4d50-af90-3752d24c8a80` returned deny. Uppercase ids `fd70ea35-6dd9-456f-96af-33cb3fc77ea6` returned `EXPLICIT_DENY`. Tag value `1.5` `2332d0e7-c036-4e60-ba55-6c981d294ad5` returned 503 with no new decision. A revoked decision insert `f04507aa-fdd2-4d2f-a35a-6cf1cb2e85ea` returned 503 with no new decision.

On the earlier image `sha256:a05a932ef2bbd271bd6b07b06ea778a9828dcf9ce5e1735dd41077ad4413f3b0`: unauthenticated policy create `3dfb18c5-2ff1-40fd-b2e9-cea75623b897` returned 401. Agent create `23dc28b2-a4bc-410c-b14f-4d6f82ad8de4` returned 201. Policy create `bd9145da-b63a-4519-a74d-2510d0730301` returned 201 and ETag `"policy-v1"`. Activate `398d9670-dd87-4a60-8fb3-44e0cc150482` returned 200 and ETag `"policy-v2"`. Evaluate `8993eece-a4d5-4797-ade6-d5c416edd70d` returned allow, `EXPLICIT_ALLOW`, and `not_enforced`. That image does not contain the match fix.

## Diffstat

Diffstat against parent `a7b608159e4deb946bc8c9b9bc6ce19120999f98`: 70 files changed, 8716 insertions(+), 48 deletions(-).
