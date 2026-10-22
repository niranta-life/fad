# Slice 7 completion

The directory writes one durable CloudEvents record for each effective change. An authorized principal can register a verified HTTPS webhook. Delivery is at-least-once.

Parent: 12498231b526aacf1bdc27bd9b4f80bb9cc4c8d9.
npm test: 2026-10-22T20:20:48Z. 36 passed. 0 failed. duration_ms=192833.115792.
Image: sha256:e19007ef47fa12ea601f475e0d5bc26f0e10e979b0197ea6b9cdf0184296dba2.
Matrix: docs/releases/slice-7/matrix.md. PASS 171. NOT RUN 0. BLOCKED 12. FAIL 0.
Journey evidence: atomicity.log, privacy.log, webhook.log, sdk.log, deploy.log.
The slice7 workflow runs tests/slice7.test.mjs and tests/slice7-matrix.test.mjs.
This history is one commit. Its parent is the Slice 6 tip above.
The gate is a later pull_request run. The slice6 job and the slice7 workflow must both succeed. headSha must equal git rev-parse HEAD.
This commit does not store its own SHA. Slice 8 is not in this commit.
