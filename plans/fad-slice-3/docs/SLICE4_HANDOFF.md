# Slice 4 (MCP) integration handoff

- Expose `fad_find_capabilities`, `fad_get_capability`, `fad_list_agent_capabilities`, `fad_get_agent_endpoint`, `fad_discover_agents`, `fad_publish_capability`, `fad_put_agent_endpoint`, and `fad_bind_capability` only as authorized tool adapters over Slice 3 application services; do NOT duplicate SQL or policy checks.
- Preserve the authenticated tenant identity, scope list, request_id and idempotency semantics from MCP transport to shared service calls.
- MCP tool-level description and user confirmation do not grant authority; enforce current scopes and governed-tag visibility at action time.
- MCP schemas should be generated or conformance-tested against existing OpenAPI models. Different protocol versioning from `/v1` is acceptable, but identical operations must have equivalent security and outcomes.
- For destructive/multi-agent writes require explicit high-impact confirmation and policy evaluation when those features arrive; Slice 3 provides no bulk mutations.
- Do not accept external A2A Agent Cards by scraping URLs inside MCP tools until separately designed, with SSRF controls and source provenance.
