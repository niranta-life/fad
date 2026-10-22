# MCP contract diff

The deployed catalog in `apps/api/src/mcp-catalog.ts` keeps these 21 tools, in this order:

`fad_list_agents`, `fad_get_agent`, `fad_register_agent`, `fad_update_agent`, `fad_suspend_agent`, `fad_activate_agent`, `fad_list_agent_tags`, `fad_put_agent_tag`, `fad_search_agents_by_tags`, `fad_list_capabilities`, `fad_publish_capability`, `fad_put_endpoint`, `fad_put_binding`, `fad_discover_agents`, `fad_list_policies`, `fad_get_policy`, `fad_create_policy`, `fad_update_draft_policy`, `fad_activate_policy`, `fad_disable_policy`, `fad_evaluate_access`.

Four tools are appended after that list:

`fad_get_enforcement_config`, `fad_preflight_enforcement`, `fad_set_enforcement_config`, `fad_get_enforcement_decision`.

`ENABLED_TOOL_NAMES` in `@fad/mcp-client` 0.2.0 stays 14 names. The journey calls the new tools with `@modelcontextprotocol/sdk` `Client.callTool`.

## Executed client

Command: `node --test --test-concurrency=1 tests/*.test.mjs`

Check: `slice 6 MCP replica and separate SDK client`

Time: 2026-10-22T03:19:55.672Z through 2026-10-22T03:19:58.896Z

Exit: the suite exited 0. This test is one of the 32 passing tests.

| Check | Result | Observation |
| --- | --- | --- |
| MCP-LIST | PASS | 25 tools. The four new names are the last four. |
| MCP-SCOPE | PASS | An `agents:read` token lists `fad_get_agent` and does not list the four enforcement tools. |
| MCP-OFF | PASS | Config mode `off`, etag `"enforcement-v0"`, organization is the caller. |
| MCP-SHADOW | PASS | Preflight passes. Config becomes `shadow`. A2 `fad_get_agent` succeeds. The decision outcome is `would_deny`. Foreign REST read of that decision is 404. |
| MCP-ENFORCE | PASS | A1 read succeeds. A2 tool error code is `NOT_FOUND` and the body omits the agent id. REST A1 is 200, REST A2 is 404, foreign agent is 404. `fad_evaluate_access` stays `not_enforced`. A hostile `X-Organization-Id` leaves the REST config on the caller organization. |
| MCP-AUD | PASS | Wrong audience `tools/list` is HTTP 401. |
| MCP-OFF-BACK | PASS | Audited OFF. A2 `fad_get_agent` succeeds. Stored mode is `off`. |

Decision id: `98db2ee8-4790-41e1-82e1-b907edb5e163`. Replica port: `64930`. Log: `mcp-evidence/clients.log`.

A direct call of a hidden enforcement tool by the reader token was not made. That case is NOT RUN. See `S09` in `test-results/matrix.md`.

CI run ID: unset.
