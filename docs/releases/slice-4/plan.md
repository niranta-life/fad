# Slice 4 plan

## Reconciliation

- Shipped `/v1` operations stay byte-for-byte. The package OpenAPI `1.4.0` differs on existing operations (response sets, descriptions, and `searchAgentsByTags` versus shipped `searchAgentsByTag`). The shipped contract wins. This slice adds `/mcp` and `GET /.well-known/oauth-protected-resource/mcp`, sets `info.version` to `1.4.0`, and leaves every preexisting operation deep-equal to parent `76573090861e9029c086942ef8f6079ba9c16982`.
- `scripts/openapi-diff.mjs` still deep-equals Slice 0, Slice 1, and the parent operations. Its parent-new set is the Slice 3 routes plus the four MCP operations. Tag `added_operations` stay the eight tag routes, so the existing tag compatibility check stays true.
- Package migration `20261021_004_mcp_identity_bindings.up.sql` sorts before shipped `20261022_001_capabilities_discovery.up.sql`. The applied file is `db/migrations/20261023_001_mcp_identity_bindings.up.sql`. The SQL is the package SQL. There is no production down script.
- `FAD_MCP_ENABLED` accepts only the exact string `true`. The default is false. With the flag off, `/mcp` is not a known route. With the flag on and no issuer configuration, the process still serves `/v1`, `/health/ready` returns not ready, and `/mcp` returns 503. A partial or invalid issuer configuration fails startup. Production rejects `FAD_MCP_JWKS_TLS_INSECURE`.
- Identity is the validated `iss`, `sub`, and `client_id` or `azp`. Lookup uses `fad_lookup_mcp_principal`. Effective scopes are the intersection of the token scopes and the binding scopes. Tool arguments cannot select an organization or a role.
- The static tool source is `plans/fad-slice-4/contracts/mcp-tools.json`. Fourteen tools are registered. Twelve disabled tools are not registered. `FAD_MCP_TOOLSET` may remove approved tools and cannot add one. Tag tools require `FAD_TAGS_ENABLED=true`. Capability, endpoint, binding, and discovery tools require `FAD_SLICE3_ENABLED=true`.
- Each mutation calls the existing service function, so the idempotency identity, audit row, and revision check match the REST command. The JSON-RPC id is not the idempotency key.
- The test issuer is an HTTPS server created by the test process. Its signing key is not copied into the image.
- `@fad/sdk` method signatures stay as released. The optional client is `@fad/mcp-client`.

## Request path

1. Reject a bad Host, a present Origin that is not allowlisted, a forwarded host when the proxy is not trusted, a query string, a duplicate `Authorization`, and a body over 64 KiB. Reject a JSON-RPC array after authentication and before the rate limit, so one POST cannot run multiple tool calls. Reject duplicate object keys after decoding JSON escapes the same way as `JSON.parse`, including `\uXXXX`.
2. Require `Authorization: Bearer` on `POST /mcp`. Verify the JWT with the configured issuer JWKS only. Reject `alg=none`, `jku`, `x5u`, a token `jwk`, a bad audience, a bad issuer, a missing client id, `nbf` in the future, and expiry.
3. Resolve the binding, then require an active organization and an active principal inside a transaction-local `fad.org_id`.
4. Serve one stateless MCP request with `@modelcontextprotocol/server` `createMcpHandler` (`legacy: 'stateless'`, `responseMode: 'json'`). The factory registers only the tools for the effective scopes. `GET` and `DELETE /mcp` return 405.

## Rollback

Set `FAD_MCP_ENABLED=false` or run the Slice 3 image. Keep `mcp_principal_bindings`.
