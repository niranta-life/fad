# API contract diff

Command: `node scripts/openapi-diff.mjs`

Result: `ok` true, `breaking` empty, `parent_preexisting_deep_equal` true, `slice0_package_unchanged` true.

| Field | Value |
| --- | --- |
| Comparison parent | `400c531d98685f8c93481ed3e527498c7b9d6fb3` |
| Published SHA-256 | `43bf7c691804efac369d2166a2ec494b9a021dfbfb611122e7ced1140efb6cac` |
| Document changes | `info`, `tags` |
| Info version | `1.5.0` (baseline fixture remains `1.4.0`) |
| Slice 0 package SHA-256 | `bb5a6dc96ae93fb42ed6b69af1770cd435bba43809c8942b0702d9a748beb4cc` |

New operations in `parent_new_operations`:

- `get /v1/policies`
- `post /v1/policies`
- `get /v1/policies/{policyId}`
- `put /v1/policies/{policyId}`
- `post /v1/policies/{policyId}/activate`
- `post /v1/policies/{policyId}/disable`
- `post /v1/authorization/evaluate`

The machine-readable report is `api-evidence/openapi-diff.json`.

## Reconciliation

The package OpenAPI is normative for behavior. The published file was extended, not replaced.

- Cache-Control uses the existing `PrivateNoStore` component. The package name `NoStore` was not added.
- 503 uses the existing `DependencyUnavailable` component. The package name `Unavailable` was not added.
- 422 stays `VALIDATION_ERROR`.
- The 257th active policy is 409 `CONFLICT`.
- ETags are strong `"policy-vN"`. `If-Match` is required on update, activate, and disable. `Idempotency-Key` is required on writes.
- The write body limit is `FAD_POLICY_WRITE_BODY_MAX_BYTES`, default and maximum 65536. The package operations document names a different variable. That name is not read.
- The active ceiling is the constant 256. It is not an environment setting that can raise the cap.
- Top-level security and servers were not changed. YAML anchors from the package were not copied.

`tests/slice5-baseline.test.mjs` deep-equals every frozen Slice 4 operation to the live document.
