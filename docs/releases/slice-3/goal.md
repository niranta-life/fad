# Slice 3 goal

Administrators publish immutable capability versions. Authorized services declare HTTPS endpoints, bind one capability version to one endpoint, and discover active agents in the same organization by capability, typed tag, and protocol.

Discovery reports `verification: self_declared`, `availability: not_checked`, and `invocation_authorization: not_evaluated`. A match is not health, trust, or permission to invoke.

The parent commit is `400c531d98685f8c93481ed3e527498c7b9d6fb3`. The released Slice 2 OpenAPI SHA-256 is `a270b34a5ae14e88f40f9aca90d08f20d055ee05b4186786669718049e429f03`.

This slice does not add a service, a database, a cache, federation, invocation, probes, or outbound calls to declared URLs.
