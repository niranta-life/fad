# Federated Agent Directory — Slice 3 Production Specification

**Slice:** 3 — Versioned Capabilities, Endpoint Declarations and Local Discovery  
**Status:** design artifacts only, **not** a running implementation  
**API contract:** `/v1`, combined OpenAPI 1.3.0 (strictly additive over bundled Slices 0–2)  
**Database:** PostgreSQL 16+, forward-only migration  
**SDK:** additive TypeScript/Node.js methods  
**Release model:** one deployable vertical slice and one focused implementation commit with real evidence

## Start here

1. [Detailed specification](docs/SPECIFICATION.md)
2. [Standalone Grok Code /goal](docs/GROK_GOAL.md)
3. [Combined OpenAPI contract](contracts/openapi.yaml)
4. [Database migration](migrations/20261020_003_capabilities_discovery.up.sql)
5. [Real API examples](examples/api-examples.md)
6. [Verification matrix](verification/TEST_MATRIX.md)
7. [Shell smoke script](verification/acceptance-smoke.sh)
8. [Node.js SDK contract](sdk/SDK_CONTRACT.md)
9. [Docker deployment and rollback](deploy/OPERATIONS.md)
10. [Architecture decisions](docs/ARCHITECTURE_DECISIONS.md)
11. [Next MCP handoff](docs/SLICE4_HANDOFF.md)

## Value after deployment

An authorized enterprise service can publish capabilities, map them to declared endpoints of existing agents, and find active matching agents using typed tags. Calls are secure within an organization and consistent under concurrent mutations. The directory does **not** execute tasks, verify runtime availability or authorize invocation.

## Required prerequisites

Complete running Slices 0–2 backend; active organization-scoped API credentials; a fresh active agent and typed tag fixture. The package includes migration scripts and tests but **not** runtime source code or a runnable independent app. Implement with the `/goal` prompt against the existing repository.

## Static validation

Use `python verification/check_contract.py` to validate the bundled OpenAPI and assert that Slices 0–2 paths/components are preserved; requires PyYAML. `bash -n verification/acceptance-smoke.sh` validates shell syntax. No claim of a successful runtime deployment should be made before executed evidence is saved.
