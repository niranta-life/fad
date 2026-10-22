# SDK compatibility

`@fad/sdk` stays `0.5.0`. `@fad/mcp-client` stays `0.2.0`.

Added client methods:

- `client.enforcement.getConfig`
- `client.enforcement.preflight`
- `client.enforcement.setConfig`
- `client.enforcement.getDecision`

Existing `organizations`, `agents`, `policies`, and `authorization` surfaces remain. The separate project called `organizations.current`, `policies.list`, `agents.get`, and `authorization.evaluate`.

## Separate install

The suite packed the built workspace SDK and installed that tarball in a second Node project with `npm install --omit=dev --no-audit --no-fund --offline`.

Check `SDK` passed at 2026-10-22T03:19:57.348Z. That run did not call `getDecision`. The decision id in that log is empty.

A later run of the same installed-tarball journey called `client.enforcement.getDecision` at 2026-10-22T06:06:29.824Z. Decision `532e487f-9169-414a-8988-7dbf01f9e00a`. Mode `enforce`. Outcome `allowed`. ETag `"enforcement-v2"`. Audited OFF then returned mode `off`. Log `sdk-evidence/clients.log`. Command exit 0. CI run ID: unset.

| Step | Result |
| --- | --- |
| Own organization | matches the caller |
| Policy list | 2 policies |
| Initial config | `off`, revision 0 |
| Shadow preflight and set | pass, mode `shadow` |
| Shadow read of the denied principal | HTTP 200, agent id `a1098c01-c289-4c1d-bb75-9dc429c1e416` |
| Evaluate during the journey | `not_enforced` |
| Enforce preflight | passes, blockers empty |
| Allowed read | HTTP 200 |
| Denied read | HTTP 404 `AGENT_NOT_FOUND` |
| Audited OFF | mode `off`, legacy read returns the same agent id |

The concealed read is `FadApiError`, not `PolicyDeniedError`. A typed `PolicyDeniedError` assertion was not run. Retry behavior of the new methods was not asserted in this journey. Existing SDK retry tests in the same suite passed: one idempotency key with no retry of 412, GET connection retry, and no retry of 401.

Log: `sdk-evidence/clients.log`.

No Python, Java, Kotlin, or Go SDK was added.

CI run ID: unset.
