# Slice 5 goal

Add policy management and hypothetical, logged policy decisions on the existing agent directory. An allow does not authorize an existing operation, issue a delegation grant, or invoke an agent.

Parent commit: `a7b608159e4deb946bc8c9b9bc6ce19120999f98`.

`FAD_POLICIES_ENABLED` accepts only the exact string `true`. The default is false. With the flag off, the seven new REST routes answer 404 and the seven new MCP tools are absent from `tools/list`. With the flag on, the same application service serves REST and MCP.

The decision string is `allow` or `deny`. Every returned decision has `enforcement` equal to `not_enforced`. Slice 6 is not started.
