# Slice 3 risks

- Discovery is a directory lookup. `availability` is `not_checked` and `invocation_authorization` is `not_evaluated`. A match is not health, trust, or permission to call the agent.
- Published schemas are self-declared. The digest proves the stored declaration. It does not prove the agent implements the schema.
- Endpoint URLs are syntax checks only. The service does not resolve or request them. A hostname that passes the grammar can still be wrong, private, or unreachable.
- `FAD_SLICE3_ENABLED` defaults to false. Credentials issued before this slice do not receive `capabilities:*` or `endpoints:*`.
- Live caps are 8 endpoints and 32 bindings per agent. A larger fleet needs a measured follow-on, not a cache added in advance.
- Catalog order is lexical on the version text, not semver order. `1.10.0` sorts before `1.9.0`.
- P1 rows PERF-01, PERF-02, and PERF-03 were not run. This workstation has no published 100k-agent or 1M-binding dataset. No latency number is claimed.
- DUR-07 restored one organization's Slice 3 rows inside a transaction. A full point-in-time recovery was not run.
- The applied migration is `20261022_001_capabilities_discovery`. The package name `20261020_003` would sort before the shipped tag migration, so it was not used. There is no production down script. Rollback is the feature flag or the previous API image, with the new tables left in place.
- Cursor MAC reuse of the API-key pepper means a pepper rotation invalidates outstanding discovery and catalog cursors.
