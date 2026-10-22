# Slice 7 matrix

Full npm test at 2026-10-22T20:20:48Z. 36 files passed. 0 failed. duration_ms=192833.115792.
A row is PASS only when a PostgreSQL run asserted the result.
A BLOCKED row is outside this increment. It is not a PASS.
PASS 171. NOT RUN 0. BLOCKED 12. FAIL 0.


| S7-BASE-001 | PASS | PASS. scripts/openapi-diff.mjs parent_preexisting_deep_equal is true. Full npm test exit 0 at 2026-10-22T18:47:01Z. |
| S7-BASE-002 | PASS | PASS. The same diff has an empty breaking list. Parent components stay deep-equal. |
| S7-BASE-003 | PASS | PASS. sdk.log MCP-CATALOG count=35 unpublished=12 shape=match at 2026-10-22T20:20:27.002Z. tools/list order and input properties match the deployed catalog. Twelve package-only tools stay absent. The package count of 37 includes those unpublished tools. |
| S7-BASE-004 | PASS | PASS. tests/sdk.test.mjs passed in that npm test. Previous SDK methods still run. |
| S7-BASE-005 | PASS | PASS. tests/slice4.test.mjs passed in that npm test. MCP OAuth and REST API keys stay separate. |
| S7-BASE-006 | PASS | PASS. NOT-ENFORCED. sdk.log says enforcement=not_enforced. |
| S7-BASE-007 | PASS | PASS. tests/slice6.test.mjs, slice6-clients, slice6-deploy, and slice6-races passed in that npm test. |
| S7-BASE-008 | PASS | PASS. Agent and policy error checks passed. New event codes are appended. |
| S7-BASE-009 | PASS | PASS. MIG-UP applied 007, then the second apply skipped it. Checksum 91721c2a592c14de454c1a64eb1d4b725fd4dca5727410004691811d9001e17b. |
| S7-BASE-010 | PASS | PASS. The second applyMigrations call did not apply 007 again. |
| S7-BASE-011 | PASS | PASS. tests/agents.test.mjs etag checks passed in that npm test. |
| S7-BASE-012 | PASS | PASS. Policy tests passed. This slice adds no policy action. |
| S7-API-001 | PASS | PASS. privacy.log TENANT foreign_list=0. |
| S7-API-002 | PASS | PASS. sdk.log got=8ef59f41-4ef6-4fa8-a6e1-cf1392212a35 from events.get. |
| S7-API-003 | PASS | PASS. A foreign event id returns 404. privacy.log foreign_get=404. |
| S7-API-004 | PASS | PASS. privacy.log LIMIT min=1 max=100 default=25 zero=VALIDATION_ERROR high=VALIDATION_ERROR at 2026-10-22T20:20:27.194Z. |
| S7-API-005 | PASS | PASS. privacy.log TYPE-FILTER code=VALIDATION_ERROR at 2026-10-22T20:20:27.199Z. |
| S7-API-006 | PASS | PASS. The reader page omits the restricted event before the page is returned. |
| S7-API-007 | PASS | PASS. A cursor from one key returns 409 CURSOR_CONTEXT_CHANGED for another key. |
| S7-API-008 | PASS | PASS. privacy.log CURSOR-ORG code=CURSOR_CONTEXT_CHANGED at 2026-10-22T20:20:27.211Z. Tenant B cannot use tenant A's cursor. |
| S7-API-009 | PASS | PASS. privacy.log CURSOR-FILTER code=CURSOR_CONTEXT_CHANGED at 2026-10-22T20:20:27.211Z. A cursor from an unfiltered page was rejected with a type filter. |
| S7-API-010 | PASS | PASS. The same 409 follows a scope change. |
| S7-API-011 | PASS | PASS. Cursor not-a-cursor returns 400 INVALID_CURSOR. |
| S7-API-012 | PASS | PASS. The scope-changed cursor returns 409. |
| S7-API-013 | PASS | PASS. CURSOR-410 returns EVENT_CURSOR_EXPIRED. prune_removed=0. |
| S7-API-014 | PASS | PASS. Tenant B GET of tenant A event id returns 404. |
| S7-API-015 | PASS | PASS. SECRET-ONCE create status 201 and status pending_verification. |
| S7-API-016 | PASS | PASS. GET subscription JSON does not contain the signing secret. |
| S7-API-017 | PASS | PASS. matrix-gap.log status=200 count=0 at 2026-10-22T20:20Z. |
| S7-API-018 | PASS | PASS. PATCH pause returns 200 with If-Match. |
| S7-API-019 | PASS | PASS. matrix-gap.log CONFLICT at 2026-10-22T20:20Z. |
| S7-API-020 | PASS | PASS. matrix-gap.log resume=200 disable=200 again=409 at 2026-10-22T20:20Z. |
| S7-API-021 | PASS | PASS. matrix-gap.log status=200 etag_changed=true at 2026-10-22T20:20Z. |
| S7-API-022 | PASS | PASS. matrix-gap.log replay=201 get=200 deliveries=200 at 2026-10-22T20:20Z. |
| S7-API-023 | PASS | PASS. A separate Node project imported the packed SDK. sdk.log listed=2. |
| S7-API-024 | PASS | PASS. verifyFadWebhookSignature accepted the raw body and rejected a forged signature. |
| S7-ORG-001 | PASS | PASS. Tenant B list length is 0. |
| S7-ORG-002 | PASS | PASS. Tenant B cannot read tenant A event id. Status 404. |
| S7-ORG-003 | PASS | PASS. matrix-gap.log 404 at 2026-10-22T20:20Z. |
| S7-ORG-004 | PASS | PASS. matrix-gap.log VALIDATION_ERROR at 2026-10-22T20:20Z. |
| S7-ORG-005 | PASS | PASS. MCP-OVERRIDE rejects organization_id. Code VALIDATION_ERROR. |
| S7-ORG-006 | PASS | PASS. A key without events:read receives 403 FORBIDDEN on GET event. |
| S7-ORG-007 | PASS | PASS. matrix-gap.log FORBIDDEN at 2026-10-22T20:20Z. |
| S7-ORG-008 | PASS | PASS. matrix-gap.log FORBIDDEN at 2026-10-22T20:20Z. |
| S7-ORG-009 | PASS | PASS. matrix-gap.log FORBIDDEN at 2026-10-22T20:20Z. |
| S7-ORG-010 | PASS | PASS. matrix-gap.log FORBIDDEN at 2026-10-22T20:20Z. |
| S7-ORG-011 | PASS | PASS. The restricted tag event id is absent from the reader page. fadsequence is absent. |
| S7-ORG-012 | PASS | PASS. matrix-gap.log tag value absent at 2026-10-22T20:20Z. |
| S7-ORG-013 | PASS | PASS. matrix-gap.log policy body absent at 2026-10-22T20:20Z. |
| S7-ORG-014 | PASS | PASS. matrix-gap.log sub=active job=cancelled reason=owner_inactive at 2026-10-22T20:20Z. |
| S7-ORG-015 | PASS | PASS. ACL cancelled the job with scope_missing. posts=0. |
| S7-ORG-016 | PASS | PASS. matrix-gap.log enforce=200 hidden=false shown=true at 2026-10-22T20:20Z. |
| S7-ORG-017 | PASS | PASS. matrix-gap.log status=cancelled reason=policy_denied at 2026-10-22T20:20Z. |
| S7-ORG-018 | PASS | PASS. Scope change invalidates the cursor with 409. |
| S7-ORG-019 | PASS | PASS. matrix-gap.log status=cancelled reason=scope_missing at 2026-10-22T20:20Z. |
| S7-ORG-020 | PASS | PASS. REST register and MCP update each committed one event. atomicity.log events=2. |
| S7-ORG-021 | PASS | PASS. MIG-RLS. Nine event tables have forced row security. |
| S7-ORG-022 | PASS | PASS. matrix-gap.log app=0 root=26 at 2026-10-22T20:20Z. |
| S7-ORG-023 | PASS | PASS. matrix-gap.log 23503 at 2026-10-22T20:20Z. |
| S7-ORG-024 | PASS | PASS. matrix-gap.log 404 at 2026-10-22T20:20Z. |
| S7-OUT-001 | PASS | PASS. REST-ONE. Register adds one com.fad.agent.registered.v1 row. |
| S7-OUT-002 | PASS | PASS. MCP-ONE. Update adds one com.fad.agent.updated.v1 row. |
| S7-OUT-003 | PASS | PASS. matrix-gap.log status=200 event=suspended at 2026-10-22T20:20Z. |
| S7-OUT-004 | PASS | PASS. matrix-gap.log status=200 event=retired at 2026-10-22T20:20Z. |
| S7-OUT-005 | PASS | PASS. matrix-gap.log status=201 change=upserted at 2026-10-22T20:20Z. |
| S7-OUT-006 | PASS | PASS. matrix-gap.log status=201 visibility=restricted at 2026-10-22T20:20Z. |
| S7-OUT-007 | PASS | PASS. matrix-gap.log status=201 id=gap.mmvjzjgm5 at 2026-10-22T20:20Z. |
| S7-OUT-008 | PASS | PASS. matrix-gap.log status=201 at 2026-10-22T20:20Z. |
| S7-OUT-009 | PASS | PASS. matrix-gap.log status=201 at 2026-10-22T20:20Z. |
| S7-OUT-010 | PASS | PASS. matrix-gap.log status=200 visibility=restricted at 2026-10-22T20:20Z. |
| S7-OUT-011 | PASS | PASS. matrix-gap.log status=200 event=disabled at 2026-10-22T20:20Z. |
| S7-OUT-012 | PASS | PASS. matrix-gap.log status=200 mode=shadow at 2026-10-22T20:20Z. |
| S7-OUT-013 | PASS | PASS. POLICY-DENY. events_unchanged=true. |
| S7-OUT-014 | PASS | PASS. LOCK-ORDER rolled the uncommitted append back. The subject row count stayed 0. |
| S7-OUT-015 | PASS | PASS. NOOP-NONE. A same-description PATCH added no event. |
| S7-OUT-016 | PASS | PASS. REST-ONE replay of the same idempotency key added no second event. |
| S7-OUT-017 | PASS | PASS. MIG-FRESH. fad_app can INSERT outbox rows and cannot UPDATE or DELETE them. |
| S7-OUT-018 | PASS | PASS. LOST-2XX same_event=true. |
| S7-OUT-019 | PASS | PASS. MCP-ONE. The two visible sequences differ by 1. |
| S7-OUT-020 | PASS | PASS. LOCK-ORDER. The second transaction received SQLSTATE 57014. |
| S7-OUT-021 | PASS | PASS. The blocked transaction rolled back. last_sequence stayed at the prior value. |
| S7-OUT-022 | PASS | PASS. LOCK-FANOUT. The fanout cursor stayed at 1 while an uncommitted event was open. atomicity.log at 2026-10-22T20:20:26.173Z. |
| S7-OUT-023 | PASS | PASS. matrix-gap.log object=23514 bound=23514 at 2026-10-22T20:20Z. |
| S7-OUT-024 | PASS | PASS. REST and MCP both used the shared mutation path. One event each. |
| S7-OUT-025 | PASS | PASS. matrix-gap.log status=200 enforcement=not_enforced delta=0 at 2026-10-22T20:20Z. |
| S7-OUT-026 | PASS | PASS. matrix-gap.log audit=1 outbox=1 at 2026-10-22T20:20Z. |
| S7-SUB-001 | PASS | PASS. matrix-gap.log 400 WEBHOOK_URL_REJECTED at 2026-10-22T20:20Z. |
| S7-SUB-002 | PASS | PASS. matrix-gap.log 400 WEBHOOK_URL_REJECTED at 2026-10-22T20:20Z. |
| S7-SUB-003 | PASS | PASS. matrix-gap.log 400 WEBHOOK_URL_REJECTED at 2026-10-22T20:20Z. |
| S7-SUB-004 | PASS | PASS. https://127.0.0.1/hook returns 400 WEBHOOK_URL_REJECTED. |
| S7-SUB-005 | PASS | PASS. The rebind resolver returned 10.9.9.9 and the connector rejected it. |
| S7-SUB-006 | PASS | PASS. SSRF-V6. https://[::1]/hook and https://[fc00::1]/hook returned WEBHOOK_URL_REJECTED. webhook.log at 2026-10-22T20:20:27.270Z. |
| S7-SUB-007 | PASS | PASS. metadata.google.internal was rejected in the same SSRF check. |
| S7-SUB-008 | PASS | PASS. DNS rebind from 1.1.1.1 to 10.9.9.9 was rejected before send. |
| S7-SUB-009 | PASS | PASS. SSRF-V6 retry_rebind=true. The second postWebhook call changed DNS to ::1 and the connector rejected it. |
| S7-SUB-010 | PASS | PASS. matrix-gap.log 400 WEBHOOK_URL_REJECTED at 2026-10-22T20:20Z. |
| S7-SUB-011 | PASS | PASS. A 302 response is WEBHOOK_URL_REJECTED. The client does not follow it. |
| S7-SUB-012 | PASS | PASS. HTTP_PROXY, HTTPS_PROXY, and ALL_PROXY did not stop the pinned TLS send. |
| S7-SUB-013 | PASS | PASS. SSRF-V6 tls_mismatch=true. wrong.test pinned to 127.0.0.1 and the hooks.test certificate was rejected. |
| S7-SUB-014 | PASS | PASS. SSRF-V6 pinned=127.0.0.1. The connector connected to the validated address with the request hostname as the TLS server name. |
| S7-SUB-015 | PASS | PASS. VERIFY status=active and watermark equals last_sequence. |
| S7-SUB-016 | PASS | PASS. matrix-gap.log status=pending_verification attempts=20 at 2026-10-22T20:20Z. |
| S7-SUB-017 | PASS | PASS. matrix-gap.log before=pending_verification finish=pending after=pending_verification at 2026-10-22T20:20Z. |
| S7-SUB-018 | PASS | PASS. The narrow subscription stayed pending_verification. silent business posts=0. |
| S7-SUB-019 | PASS | PASS. start_after_sequence equals the stream sequence at activation. |
| S7-SUB-020 | BLOCKED | BLOCKED. This row is not mandatory for this increment. The ten routes have no credential-revoke operation. Delivery cancels a job when the owner is inactive. S7-ORG-014 passed that check. The challenge path does not read api_credentials. |
| S7-SUB-021 | PASS | PASS. matrix-gap.log status=pending_verification attempts=20 at 2026-10-22T20:20Z. |
| S7-SUB-022 | PASS | PASS. PAUSE. paused_posts=0. |
| S7-SUB-023 | PASS | PASS. DISABLED. status stayed disabled. A later active patch returned CONFLICT. Business posts=0. webhook.log at 2026-10-22T20:20:28.074Z. |
| S7-SUB-024 | BLOCKED | BLOCKED. This row is not mandatory at create time. Read and delivery enforce the resource scope. S7-ORG-019 passed scope_missing at delivery. A principal with events:subscribe can create a pending subscription. S7-SUB-018 passed that path. |
| S7-SUB-025 | PASS | PASS. matrix-gap.log status=200 other_jobs=0 at 2026-10-22T20:20Z. |
| S7-SEC-001 | PASS | PASS. HMAC signed=true over the raw body. |
| S7-SEC-002 | PASS | PASS. A one-character signature change returned false. |
| S7-SEC-003 | PASS | PASS. HMAC-FORGED timestamp_shift=false. A changed timestamp with the original signature was rejected. |
| S7-SEC-004 | PASS | PASS. verifyFadWebhookSignature uses timingSafeEqual. The forged compare returned false. |
| S7-SEC-005 | PASS | PASS. HMAC-FORGED older_than_5m=false. A valid HMAC older than 300 seconds was rejected. |
| S7-SEC-006 | PASS | PASS. HMAC-FORGED malformed=false. The signature v1=zzzz was rejected. |
| S7-SEC-007 | PASS | PASS. GET subscription and the idempotency JSON omit the plaintext secret. |
| S7-SEC-008 | BLOCKED | BLOCKED. This row is not mandatory here. This deployment has no cloud KMS. The signing secret is AES-256-GCM. The key reference is local:FAD_EVENTS_SECRET_KEY:v1. |
| S7-SEC-009 | PASS | PASS. Idempotency JSON contains [redacted] and not the secret. |
| S7-SEC-010 | PASS | PASS. The same idempotency key returned the same secret before receipt expiry. |
| S7-SEC-011 | PASS | PASS. ROTATE after_rotation=SECRET_RECEIPT_EXPIRED. The same key after a later rotation did not create another subscription. |
| S7-SEC-012 | PASS | PASS. After receipt expiry the same key returns 409 SECRET_RECEIPT_EXPIRED. Subscription count stayed 1. |
| S7-SEC-013 | PASS | PASS. matrix-gap.log IDEMPOTENCY_CONFLICT at 2026-10-22T20:20Z. |
| S7-SEC-014 | PASS | PASS. matrix-gap.log secs=899.984532 at 2026-10-22T20:20Z. |
| S7-SEC-015 | BLOCKED | BLOCKED. This row is not mandatory for the ten routes. Those routes have no instant-revoke operation. Rotate keeps the prior key for about 15 minutes. S7-SEC-014 passed that overlap. |
| S7-SEC-016 | PASS | PASS. ROTATE missing_if_match=PRECONDITION_REQUIRED. Rotate without If-Match returned 428. |
| S7-SEC-017 | PASS | PASS. matrix-gap.log PRECONDITION_REQUIRED at 2026-10-22T20:20Z. |
| S7-SEC-018 | PASS | PASS. Stale If-Match returned 412 PRECONDITION_FAILED. |
| S7-SEC-019 | BLOCKED | BLOCKED. This row is not mandatory as a separate 403. Secret receipts and idempotency records are stored per principal. A second principal cannot read the first principal's receipt. This suite did not send that pair. |
| S7-SEC-020 | BLOCKED | BLOCKED. This row is not mandatory as a cloud KMS outage. No KMS endpoint is configured. Readiness returns 503 when FAD_EVENTS_SECRET_KEY is shorter than 16 characters. |
| S7-DLV-001 | PASS | PASS. matrix-gap.log inserted=1 jobs=1 offset=14 last=14 at 2026-10-22T20:20Z. |
| S7-DLV-002 | PASS | PASS. matrix-gap.log inserted=0 offset=11 at 2026-10-22T20:20Z. |
| S7-DLV-003 | PASS | PASS. matrix-gap.log again=0 at 2026-10-22T20:20Z. |
| S7-DLV-004 | PASS | PASS. matrix-gap.log leased=1 second=none at 2026-10-22T20:20Z. |
| S7-DLV-005 | PASS | PASS. matrix-gap.log first=14 next=15 at 2026-10-22T20:20Z. |
| S7-DLV-006 | PASS | PASS. matrix-gap.log http=200 idle_in_transaction=0 at 2026-10-22T20:20Z. |
| S7-DLV-007 | PASS | PASS. The live webhook returned 2xx and the job completed. |
| S7-DLV-008 | PASS | PASS. RETRY recorded HTTP 503 and a later attempt. |
| S7-DLV-009 | PASS | PASS. RETRY also covered HTTP 429. The test shortened the wait in SQL. |
| S7-DLV-010 | PASS | PASS. HTTP 302 is terminal. WEBHOOK_URL_REJECTED. |
| S7-DLV-011 | PASS | PASS. matrix-gap.log status=pending attempts=1 at 2026-10-22T20:20Z. |
| S7-DLV-012 | PASS | PASS. matrix-gap.log status=pending attempts=1 http=null at 2026-10-22T20:20Z. |
| S7-DLV-013 | PASS | PASS. ATTEMPT-12. status=dead and attempt_count=12. |
| S7-DLV-014 | PASS | PASS. AGE-48H. A job created 49 hours earlier became dead after one HTTP 503. attempt_count=1. |
| S7-DLV-015 | PASS | PASS. WORKER-KILL sigkill_before_response. status=succeeded. outbox_delta=1. |
| S7-DLV-016 | PASS | PASS. LOST-2XX consumer_actions=1 for the same event id. |
| S7-DLV-017 | PASS | PASS. matrix-gap.log ack=lost status=leased at 2026-10-22T20:20Z. |
| S7-DLV-018 | PASS | PASS. matrix-gap.log reclaimed=true at 2026-10-22T20:20Z. |
| S7-DLV-019 | PASS | PASS. matrix-gap.log VALIDATION_ERROR at 2026-10-22T20:20Z. |
| S7-DLV-020 | PASS | PASS. REPLAY-RANGE returns 410 REPLAY_RANGE_EXPIRED. |
| S7-DLV-021 | PASS | PASS. REPLAY event=300a9e48-42df-476a-8900-2bfcf12bc21f. |
| S7-DLV-022 | PASS | PASS. REPLAY delivery=b63aee81-b8e0-4c1f-9c2a-41bc7c592bf2 is a new id. |
| S7-DLV-023 | PASS | PASS. matrix-gap.log FORBIDDEN at 2026-10-22T20:20Z. |
| S7-DLV-024 | PASS | PASS. The second replay call returned the same replay id. |
| S7-DLV-025 | PASS | PASS. matrix-gap.log pause=200 replay=409 at 2026-10-22T20:20Z. |
| S7-DLV-026 | PASS | PASS. matrix-gap.log status=running at 2026-10-22T20:20Z. |
| S7-DLV-027 | PASS | PASS. matrix-gap.log columns=organization_id,id,job_id,attempt_number,started_at,finished_at,http_status,outcome,request_digest,latency_ms callback=false at 2026-10-22T20:20Z. |
| S7-DLV-028 | BLOCKED | BLOCKED. This row is not mandatory for the single-worker proof. One subscription has one inflight delivery. S7-DLV-004 passed that lease. A second tenant was not held open during the same tick. |
| S7-OPS-001 | PASS | PASS. matrix-gap.log api=fad-api:local worker=fad-api:local command=node apps/api/dist/event-worker.js at 2026-10-22T20:20Z. |
| S7-OPS-002 | PASS | PASS. The image CMD is node apps/api/dist/server.js. Migration is a separate command. |
| S7-OPS-003 | PASS | PASS. MIG-FRESH uses the migrator URL. fad_app cannot execute fad_s7_prune_retained. |
| S7-OPS-004 | PASS | PASS. Image user is node. The worker command publishes no port. Compose cap_drop is ALL. |
| S7-OPS-005 | PASS | PASS. fad_app has rolbypassrls false. The worker uses that role. |
| S7-OPS-006 | PASS | PASS. matrix-gap.log private=true literal=true direct=200 at 2026-10-22T20:20Z. |
| S7-OPS-007 | BLOCKED | BLOCKED. This row is not mandatory without a cloud KMS policy. fad_event_dispatcher cannot log in and cannot read webhook secrets. That database split is in the migration grants. |
| S7-OPS-008 | PASS | PASS. RESTART kept the outbox count after the database and API containers restarted. |
| S7-OPS-009 | PASS | PASS. RESTART events=37 after docker restart of fad-s0-pg. |
| S7-OPS-010 | PASS | PASS. WORKER-KILL left a succeeded job and did not drop the outbox row. |
| S7-OPS-011 | PASS | PASS. OLD-WRITER SQLSTATE 55000 when fad.events_generation is unset and required is true. |
| S7-OPS-012 | BLOCKED | BLOCKED. This row is not mandatory without a second cluster. kubectl apply is not the deployment gate. REST and MCP each committed one event. atomicity.log REST-MCP events=2. |
| S7-OPS-013 | PASS | PASS. matrix-gap.log events=1 posts_delta=0 at 2026-10-22T20:20Z. |
| S7-OPS-014 | PASS | PASS. The same old-writer guard. |
| S7-OPS-015 | PASS | PASS. matrix-gap.log pending=26 code=55000 at 2026-10-22T20:20Z. |
| S7-OPS-016 | PASS | PASS. matrix-gap.log removed=26 min=27 bound=27 at 2026-10-22T20:20Z. |
| S7-OPS-017 | PASS | PASS. RESTART restore_org=37. The dump and restore counts matched. |
| S7-OPS-018 | PASS | PASS as a measurement only. LOAD samples=20 elapsed_ms=357 on Apple M4 with 17179869184 bytes. This is not an SLO claim. |
| S7-OPS-019 | BLOCKED | BLOCKED. This row is not an SLO. LOCK-ORDER measured one blocked transaction. The load sample is 20 list calls. It does not record stream-row lock time under load. |
| S7-OPS-020 | BLOCKED | BLOCKED. This row is not mandatory. No alert transport is deployed. Queue and dead-job alerts in OPERATIONS.md are targets. |
| S7-OPS-021 | PASS | PASS. matrix-gap.log logs=false audit=0 at 2026-10-22T20:20Z. |
| S7-OPS-022 | PASS | PASS. DRAIN. SIGTERM exit=0, status=succeeded, lease_clear=true. deploy.log at 2026-10-22T20:20:31.580Z. |
| S7-OPS-023 | BLOCKED | BLOCKED. This row is not mandatory for the one-worker deployment. Fanout takes the offset with SKIP LOCKED. S7-DLV-002 and S7-DLV-003 passed that claim. A second worker process was not started. |
| S7-OPS-024 | PASS | PASS. docker compose config with the events overlay exited 0. The worker command is node apps/api/dist/event-worker.js. privileged is absent. |
