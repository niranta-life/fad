# Slice 3 evidence package template

Copy this into the implementation repository at `docs/releases/slice-3/` and fill with ACTUAL outputs only.

## `completion.md` required fields

- Repository, branch, commit hash:
- Deployed OCI image digest and configuration hash:
- API OpenAPI SHA256 before / after; compatibility diff result:
- PostgreSQL migration checksum + applied_at:
- Running environment/test cluster and three API replica identifiers:
- Organization A/B test principal IDs (nonsecret test fixtures only):
- API test run command and run ID:
- P0 test count, pass/fail, linked evidence:
- SDK consumer tarball SHA256 and test result:
- Cross-tenant SQL proof location:
- Concurrent mutation test log:
- Restricted tag and SSRF negative test proof:
- Restart/restore/rollback proof:
- Performance dataset, CPU/memory/DB resources and p95 results:
- Open risks with mitigation/owner:
- Reviewer and signoff:

## Expected folder layout

```text
docs/releases/slice-3/
  goal.md
  plan.md
  api-contract-diff.json
  migration-checksum.txt
  schema-proof.txt
  api-evidence/
  security-evidence/
  sdk-evidence/
  container-evidence/
  load-evidence/
  rollback-evidence/
  risks.md
  completion.md
```

Each test entry must record timestamp, environment, command, expected and observed results, redacted request/response, status, request_id, CI job link when available. Do not publish API keys, signing material or governed-tag private values. Never invent "PASS" evidence.
