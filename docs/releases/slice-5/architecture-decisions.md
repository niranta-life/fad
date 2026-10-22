# Slice 5 architecture decisions

## AD-1. One service, two adapters

`packages/db/src/policies.ts` owns create, list, get, draft update, activate, disable, and evaluate. REST handlers and the seven MCP tools only adapt that service. They use the existing API-key verifier and the existing OAuth binding intersection. There is no second identity provider and no caller-selected tenant.

## AD-2. Pure compiler

`packages/db/src/policy-rules.ts` parses `PolicyDefinitionInput` and computes the decision. It rejects unknown properties, unknown operators, duplicate subjects, duplicate tag keys, malformed UUIDs, and caller-supplied tag or state claims. It does not evaluate dynamic code. Comparison is typed: the string `"100"` does not equal the integer `100`.

## AD-3. Explicit deny, then allow, else deny

Only `active` policies are considered. Order is: inactive organization or principal yields `SUBJECT_INACTIVE`; an agent that is not `active` yields `RESOURCE_INACTIVE`; any matching deny yields `EXPLICIT_DENY`; any matching allow yields `EXPLICIT_ALLOW`; otherwise `NO_MATCHING_ALLOW`. A missing, deleted, or tombstoned tag does not match. Draft and disabled policies do not match.

## AD-4. Immutable active definitions

A new row is draft revision 1. A draft may be replaced or activated. Activation and disable each increment the revision and append `fad_policy_revisions`. An active definition cannot be edited. Disable is terminal. A draft cannot be disabled. The database trigger enforces the same transitions.

## AD-5. One committed decision

`evaluateAgentAccess` opens `REPEATABLE READ` for that call, reads the current organization, principal, agent, tags, and active policies, and inserts one `fad_policy_decisions` row before commit. The HTTP 200 is after that commit. Digests are SHA-256 of canonical JSON. The row does not store raw tag values, tokens, or secrets. `withTenant` for other operations stays `READ COMMITTED`.

## AD-6. Restricted selectors stay hidden

A selector on a governed or restricted tag definition marks the policy restricted. A caller without `tags:restricted:read` receives 404 for that policy and receives no explanation or policy-set digest when any considered policy is restricted. Creating such a selector without that scope is 403.

## AD-7. Flag and rollback

The image and Compose default `FAD_POLICIES_ENABLED` to false. Schema expansion is the migrator job, which uses advisory lock `764001`. Image rollback keeps the tables. `20261021_005_policy_evaluation.down.sql` is development-only. The runner ignores `.down.sql`. The down script refuses when decisions exist or a non-draft policy exists.

## AD-8. Contract reconciliation

Published OpenAPI stays the source the generator reads. New operations were inserted. Preexisting operation objects stay deep-equal to the comparison base. Cache control uses the existing `PrivateNoStore` reference. Dependency failure uses `DependencyUnavailable`. The 257th active policy uses the new `CONFLICT` code. The package names `NoStore` and `Unavailable` were not copied, and YAML anchors were not copied.
