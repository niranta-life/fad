# API contract diff

Command: `node scripts/openapi-diff.mjs`

Saved report: `api-evidence/openapi-diff.json`. File time 2026-10-21 20:09:03 local. `ok` is true. `breaking` is empty. `parent_preexisting_deep_equal` is true. `slice0_package_unchanged` is true.

The same command ran again inside the 2026-10-22T03:18:59Z suite. `tests/slice4.test.mjs` and `tests/tags.test.mjs` fail the suite when the script exits 1. Both tests passed.

| Field | Value |
| --- | --- |
| Script comparison parent | `400c531d98685f8c93481ed3e527498c7b9d6fb3` |
| Published SHA-256 | `f3f7a7f410136ace9edf7daa5173b75a77ff6288ef7a35563ad7ca62368ae7e4` |
| Slice 0 package SHA-256 | `bb5a6dc96ae93fb42ed6b69af1770cd435bba43809c8942b0702d9a748beb4cc` |
| Info version | `1.5.0` |
| Frozen Slice 5 paths | 27 |
| Frozen Slice 5 operations | 41 |
| Live paths | 30 |
| Live operations | 45 |
| Document changes | `info`, `tags` |

`tests/slice6-contract.test.mjs` deep-equals every frozen Slice 5 operation to the live document. The only added paths are `/v1/enforcement/config`, `/v1/enforcement/preflight`, and `/v1/enforcement/decisions/{decisionId}`. `EvaluationDecision.enforcement.const` stays `not_enforced`.

The script's parent-new set is the Slice 3 routes, the MCP routes, the seven policy routes, and the four enforcement routes. That set has 27 operations. Preexisting operations, including the tag routes, stay deep-equal.

## Request ids from the HTTP journey

| Call | Request id | Time |
| --- | --- | --- |
| GET config while OFF, with `X-Organization-Id` set to the other org | `30a6bacc-a843-489f-9b7d-a5eb5bbdc7f0` | 2026-10-22T03:20:11.717Z |
| PUT ENFORCE | `ee58f55b-a668-4e99-8687-e2f88cfbd6dd` | 2026-10-22T03:20:12.916Z |
| PUT OFF | `aa7b3277-a4d9-4682-99d6-e64bcbd2d0b2` | 2026-10-22T03:20:23.977Z |

CI run ID: unset.
