# Slice 0 goal

Ship a tenant-safe Federated Agent Directory control-plane foundation.

The running system is a Node.js 24 LTS API, PostgreSQL 16, an offline `fad-admin` CLI, the `@fad/sdk` client, and a non-root container. It serves `GET /health/live`, `GET /health/ready`, and `GET /v1/organizations/current`. An API key resolves only the organization bound to that key.

This release does not add agent registration, tags, MCP, federation, OAuth, a UI, or public admin routes. Slice 1 is not started.
