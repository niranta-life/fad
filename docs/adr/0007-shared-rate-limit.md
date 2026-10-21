# ADR 0007: Shared rate limit uses PostgreSQL

An in-memory counter is a different limit on each replica. The package migration has no counter table, and that file must stay byte-identical.

Decision: additive migration `0002_rate_limit.up.sql` creates `rate_limit_buckets`, grants DML to `fad_app`, and rejects scope `*`. The bucket key is a SHA-256 of the pepper and a kid or client address. The raw key is not stored. `FAD_RATE_LIMIT_BACKEND=postgres` is required. There is no production in-memory backend. The table has no row security because it is not tenant data.

Contract check: two API processes share one budget; the third request to the other process returns 429 with `Retry-After`.
