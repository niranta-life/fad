# ADR 0004: Credentials are active or revoked

The prose says to reject a disabled key. The table check allows only `active` and `revoked`.

Decision: do not add a `disabled` credential status. Expired keys stay `active` with `expires_at <= now()` and fail authentication. Revoked keys fail authentication. A disabled principal or a suspended organization also fails authentication as generic 401. Those states are not reported in the error body.

Contract check: `api_credentials_status_check` remains `active|revoked` in the package migration.
