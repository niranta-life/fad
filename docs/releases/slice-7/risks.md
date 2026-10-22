# Slice 7 risks

- Webhook secrets use AES-256-GCM from FAD_EVENTS_SECRET_KEY. This is a local key. It is not a cloud KMS. S7-SEC-008 stays NOT RUN.
- fad_app can SELECT webhook ciphertext inside its tenant. The worker uses fad_app. fad_event_dispatcher cannot log in and cannot read secrets.
- Delivery scope checks read API credential scopes through fad_s7_principal_scopes. An MCP binding with no API credential is denied at send time with scope_missing.
- A secret sealed with an old key cancels that job. One cancelled job ends that organization's delivery loop for the current tick.
- CURSOR-410 changed the cursor retention field. prune_removed=0 in that run. The prune did not have to delete a pending job to pass.
- Twelve rows are BLOCKED. They are not mandatory for this increment and they are not PASS. See matrix.md. They are S7-SUB-020, S7-SUB-024, S7-SEC-008, S7-SEC-015, S7-SEC-019, S7-SEC-020, S7-DLV-028, S7-OPS-007, S7-OPS-012, S7-OPS-019, S7-OPS-020, and S7-OPS-023. No cloud KMS, no alert transport, no second cluster, and no second worker process are present.
- Production TLS boot against fad-s0-pg is BLOCKED. That server has no TLS.
- Load samples=20 and elapsed_ms=357 on Apple M4 with 17179869184 bytes. That measurement is not an SLO result.
