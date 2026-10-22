# MCP contract diff

`ENABLED_TOOL_NAMES` in `@fad/mcp-client` 0.2.0 stays the original 14 tools, in the same order. `tests/slice5-baseline.test.mjs` asserts that order against `tests/fixtures/slice4-baseline.json`.

`APPROVED_MCP_TOOLS` adds seven names after `fad_discover_agents`:

- `fad_list_policies`
- `fad_get_policy`
- `fad_create_policy`
- `fad_update_draft_policy`
- `fad_activate_policy`
- `fad_disable_policy`
- `fad_evaluate_access`

They are registered only when `FAD_POLICIES_ENABLED` is `true` and the effective scopes allow them. Effective scopes remain the intersection of the token, the binding, and `KNOWN_SCOPES`.

`fad_evaluate_access` is listed when the caller has `agents:read` and either `policies:evaluate:self` or `policies:evaluate:any`. The service applies the same check. `evaluate:any` is an alternative to `evaluate:self`. The tool descriptor does not require both.

The server protocol version string stays `1.4.0`. The client connect version is `0.2.0`. Helpers are additive and OAuth-only. `evaluateAccess` uses a single attempt and does not send an idempotency key.

Observed `tools/list` for an admin token with the flag on is in `mcp-evidence/mcp.log`. With the flag off, the same binding's `tools/list` included `fad_list_agents` and no policy tool. Proof ids: `MCP`, `MCP-OFF` in `test-results/proof.log`.

A missing `if_match` is rejected by the client from the server schema (`FadMcpProtocolError`) and does not change the revision. A stale `If-Match` returns `REVISION_CONFLICT`. A foreign subject returns `NOT_FOUND` and writes no decision row for that subject. An audience that is not the resource returns `UnauthorizedError`. A binding limited to `policies:read` does not expose `fad_create_policy`, and a create call does not insert a row.
