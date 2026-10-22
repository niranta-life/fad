# Slice 7 results

Parent commit: 12498231b526aacf1bdc27bd9b4f80bb9cc4c8d9.
Full npm test: 2026-10-22T20:20:48Z. 36 files passed. 0 failed. duration_ms=192833.115792.
This file does not store this commit's SHA. Read it with git rev-parse HEAD after the commit.

## Journey

1. PASS. The test created organization A and B, principals, API keys, and one MCP binding. REST and MCP authenticated on their own. atomicity.log REST-MCP request=f7dc645b-dea8-4ef1-89dc-3904df7cf4e6.
2. PASS. REST register and MCP description update produced two ordered events. Tenant B list length was 0. privacy.log foreign_list=0 foreign_get=404.
3. PASS. Ordinary and governed tag definitions and a capability publish returned 201. The reader page hid the restricted event and hid fadsequence. privacy.log RESTRICTED hidden=concealed.
4. PASS. Create returned pending_verification and the secret once. The HTTPS challenge set status active. Watermark was 5. webhook.log VERIFY.
5. PASS. The agent update webhook used CloudEvents id 41380473-be59-412a-a3c4-73d06206e390 and delivery id 96d64090-d503-4ba5-9928-c4e7c9c3eeda. HMAC signed=true. The pending subscriber received no business post.
6. PASS. HTTP 503 and 429 retried. Attempt 12 dead-lettered. Lost 2xx kept consumer_actions=1. SIGKILL before the response left status=succeeded and outbox_delta=1.
7. PASS. Replay id 77292055-ed3f-41eb-b44c-fc0063376994 reused event 300a9e48-42df-476a-8900-2bfcf12bc21f and created delivery b63aee81-b8e0-4c1f-9c2a-41bc7c592bf2. An out-of-range replay returned 410.
8. PASS. Stale If-Match returned 412. Secret retry after expiry returned 409 and did not create a second subscription. Policy denial left the outbox count unchanged. Scope removal cancelled delivery with scope_missing. MCP organization_id was rejected.
9. PASS. Database restart kept events=37 and jobs=12. Restore count was 37. An old writer without fad.events_generation received SQLSTATE 55000.

The same run also passed secret rotation, a disabled terminal subscription, IPv6 and TLS egress checks, forged HMAC rejection, the 48 hour dead-letter, an uncommitted fanout cursor, and SIGTERM drain. See webhook.log, atomicity.log, and deploy.log.

## Contract

OpenAPI info.version stays 1.5.0. The ten event routes are in parent_new_operations. They are not in added_operations. added_operations stays the eight tag routes. contract-routes.log says ok=true, breaking=0, event_routes_inside_added_operations=0, parent_new_operations_are_slice7_routes=true, and parent_preexisting_deep_equal=true. POST /v1/authorization/evaluate still returns enforcement not_enforced. MCP tools when events are off stay the previous 25. The ten event tools are appended and gated by FAD_EVENTS_ENABLED. sdk.log MCP-CATALOG count=35 unpublished=12 shape=match. SDK user agent stays @fad/sdk/0.5.0. verifyFadWebhookSignature is the new export.

## Database and image

Migration checksums are in deploy.log. Nine event tables force RLS. Image fad-api:slice7 is sha256:e19007ef47fa12ea601f475e0d5bc26f0e10e979b0197ea6b9cdf0184296dba2. User is node. Command is the API server. The worker command is node apps/api/dist/event-worker.js. Compose config exited 0. privileged is absent. fad_event_capture_control.required was false after the suite.

## Rollback

Pause delivery by setting the subscription to paused or by stopping the worker. That keeps the outbox. Do not roll API writers back to an image that does not set fad.events_generation while fad_event_capture_control.required is true. That writer receives SQLSTATE 55000. Do not delete event rows or audit rows on rollback.

## CI

The gate is a GitHub Actions pull_request run whose conclusion is success and whose headSha equals git rev-parse HEAD. The develop job slice6 and the slice7 workflow must both succeed. The slice7 job runs tests/slice7.test.mjs and tests/slice7-matrix.test.mjs. That checkout uses full git history so the OpenAPI diff can read the frozen parent commit. Local npm test is not that gate. The run id is recorded after the push. It is not in this tree.
