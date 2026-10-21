# Slice 4 risks

- The package OpenAPI is not a drop-in replacement for the shipped document. Replacing it would change published `/v1` operations. This slice does not do that.
- A commit cannot contain its own object id. `completion.md` records the parent commit. The finished HEAD is reported after the commit.
- Performance cases record the measured elapsed time of the executed check on this machine. They are not capacity targets. A case that cannot run is `NOT RUN` with the observed error.
- JWKS responses are cached per process with a bounded cooldown. A binding or scope change is read from PostgreSQL on every request and is not cached.
- The per-organization concurrency counter is local to the process. It limits one replica. It does not store a principal or a token. Authorization does not read it. A JSON-RPC array is rejected before that counter, so one POST cannot run multiple tool calls.
- Object-key limits decode JSON escapes, including `\uXXXX`, before the duplicate check. A literal key and its escaped form count as the same key.
- `fad_app` cannot insert bindings. A mistaken grant fails process startup after the migration is present.
