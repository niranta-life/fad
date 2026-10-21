# Slice 4 goal

Add an authenticated MCP adapter on the existing agent directory. MCP calls the same application services as `/v1`. It does not add a second registry, a policy engine, delegation, federation, remote discovery, or agent execution.

Parent commit: `76573090861e9029c086942ef8f6079ba9c16982`.

Baseline OpenAPI SHA-256 before this slice: `5bdc14f2c918e60e7ba6c61040293b2db9199bf24a347ae7e9afcca58da95f90`. Contract version at that commit: `1.3.0`. Twenty paths. SDK `@fad/sdk` `0.4.0`.

Shipped migrations through `20261022_001_capabilities_discovery.up.sql`. The MCP mapping migration is `20261023_001_mcp_identity_bindings.up.sql`.

MCP SDK pins, verified from the npm registry before use: `@modelcontextprotocol/server` `2.3.1`, `@modelcontextprotocol/client` `2.3.1`, `jose` `6.1.3`, `zod` `4.6.7`.
