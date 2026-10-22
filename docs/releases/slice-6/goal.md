# Slice 6 goal

Add a shared Policy Enforcement Point for covered agent operations on REST and MCP.

The tenant starts OFF. An admin with `enforcement:manage` can run a shadow preflight, switch to SHADOW, and see a would-deny decision while the old read still succeeds. A passing ENFORCE preflight and an explicit acknowledgement can then select `agent.read`. A caller with `agents:read` and a matching active allow can read an active agent. A caller with the same scope and no allow receives a concealed 404. An explicit deny wins for the tested update replay. A missing old scope stays 403. The admin can return the tenant to OFF with the current ETag, an idempotency key, a reason, and an audit row.

The same configuration service is used by the four new MCP tools and by `@fad/sdk` 0.5.0 from a separate Node.js project. Tenant B reads its own OFF configuration. Tenant B does not receive tenant A agents or tenant A decisions.

`POST /v1/authorization/evaluate` stays `not_enforced`. `agent.invoke` is not enforceable. Slice 7 is out of scope.

Parent commit: `27a3f2874e8fbaa256ac88ab982904ae2ee26cdd`.

This blob does not store its own id.

The 134 matrix rows are PASS. R19 is the successful Actions `pull_request` run whose headSha equals `git --no-replace-objects rev-parse HEAD`. This blob does not store the run id or the commit id. The tested image rerun is in `deployment-evidence/image-rerun-f3a44c87.log`. The production TLS boot for that image is in `deployment-evidence/prod-tls-f3a44c87.log`. `kubectl apply` is not a Docker gate and is not a pass.
