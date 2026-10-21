# @fad/mcp-client

Optional MCP client for the Federated Agent Directory. `@fad/sdk` is unchanged.

The client sends `Authorization: Bearer` from `tokenProvider` on each request. It does not store the token and it does not issue one. A write keeps the caller-supplied `idempotency_key`. If the connection ends after the server may have committed, the error is `FadMcpIndeterminateError`. Retry that call with the same key and the same arguments.

`preferredVersion` `2026-07-28` pins the modern protocol. `2025-11-25` uses the legacy initialize sequence.
