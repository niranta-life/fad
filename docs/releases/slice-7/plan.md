# Slice 7 implementation plan

Parent commit: 12498231b526aacf1bdc27bd9b4f80bb9cc4c8d9.

1. Keep every published Slice 0–6 operation. Append ten event operations and ten MCP tools.
2. Add migration 20261021_007_durable_events. Keep RLS, grants, and the writer guard.
3. Write one outbox event inside each effective shared mutation. Skip rollback, no-op, and denial.
4. Verify webhook subscriptions on the same HTTPS egress path used for delivery.
5. Fan out and deliver with leases. Retry, then dead-letter. Replay retained events only.
6. Add SDK events methods and verifyFadWebhookSignature. Prove them from a packed client.
7. Run the old suites and the Slice 7 matrix on PostgreSQL. Store the logs in this directory.
8. Make one commit. Do not start Slice 8.

## Deviations

- The Slice 7 package lists 30 routes and 37 MCP tools. This repository had 30 paths, 45 operations, and 25 MCP tools. The new document keeps those operations and appends eight paths, ten operations, and ten tools.
- tests/slice6-contract.test.mjs now expects 55 operations and the ten event tools. The frozen Slice 5 operation objects stay equal.
- Webhook secrets use AES-256-GCM from FAD_EVENTS_SECRET_KEY. This is a local key, not a cloud KMS product.
- fad_app can read secret ciphertext under RLS. The worker uses that same role. fad_event_dispatcher only lists organization ids and cannot log in.
- OpenAPI info.version stays 1.5.0. The SDK user agent stays @fad/sdk/0.5.0.
- Migration 20261021_007 sorts before the Slice 3 tables. A fresh database skips those guards in that file. Migration 20261024_001 adds any guard that is still missing. The development database already applied an earlier copy of 007. Its stored checksum is aligned to the edited file. The guard objects already exist.
- fad_s7_prune_retained runs as fad_bootstrap. Migration 20261025_001 grants that role the delete and update rights the function uses. fad_app does not receive those grants.
- fad_s7_writer_guard runs as fad_bootstrap. Migration 20261026_001 grants that role SELECT on fad_event_capture_control.
- Delivery reads owner scopes through fad_s7_principal_scopes. Migration 20261027_001 owns that function as fad_auth_reader. fad_app does not receive SELECT on api_credentials.
- The delivery claim uses a SQL due flag. It does not compare next_attempt_at with the host clock.
- A secret the current key cannot open cancels that job or increments verification attempts. Other organizations still run.
- scripts/openapi-diff.mjs allows the ten event operations as additive routes. Frozen parent operations stay deep-equal.
- tests/slice6-deploy.test.mjs copies the database password into the Docker network URL. The bridge requires SCRAM. The test does not print the URL.
- CURSOR-410 passed with prune_removed=0. The cursor retention field changed. That run did not delete a pending job.
- A production TLS boot against fad-s0-pg is BLOCKED. That server has no TLS. The suite did not weaken SSL.
- This commit does not contain its own SHA or the Actions run id. The gate is the pull_request run whose headSha equals that SHA.
