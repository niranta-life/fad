# Slice 1 goal

An authorized organization service can register an AI agent and manage its directory lifecycle. The agent has a stable id, a global URN, revision history, and an audit row for each real change. Another organization cannot read or change that agent.

Slice 1 adds these HTTP operations to the existing FAD service:

- `POST /v1/agents`
- `GET /v1/agents`
- `GET /v1/agents/{agentId}`
- `PATCH /v1/agents/{agentId}`
- `POST /v1/agents/{agentId}/suspend`
- `POST /v1/agents/{agentId}/activate`
- `POST /v1/agents/{agentId}/retire`

`@fad/sdk` 0.2.0 exposes `agents.register`, `get`, `list`, `update`, `suspend`, `activate`, `retire`, and `iterate`.

Slice 1 does not add a user interface. It does not add tags, capabilities, discovery, a policy engine, delegation, MCP, federation, or another SDK language. It does not add a DELETE operation.
