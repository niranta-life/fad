-- Additive Slice 0 rate-limit storage. See docs/adr/0007-shared-rate-limit.md.
-- The migration runner executes this file and the checksum insert in one transaction.

CREATE TABLE rate_limit_buckets (
  bucket_key text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  hit_count integer NOT NULL,
  CONSTRAINT rate_limit_hits_nonnegative CHECK (hit_count >= 0),
  CONSTRAINT rate_limit_key_length CHECK (length(bucket_key) BETWEEN 16 AND 128)
);

REVOKE ALL ON rate_limit_buckets FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON rate_limit_buckets TO fad_app;

ALTER TABLE api_credentials
  ADD CONSTRAINT api_credentials_no_wildcard_scope
  CHECK (NOT ('*' = ANY (scopes)));
