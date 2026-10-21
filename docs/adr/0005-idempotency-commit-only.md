# ADR 0005: Idempotency rows are written only on commit

The prose describes an in-progress wait. The table has no status column, `fad_app` has no `UPDATE`, and a row exists only when the surrounding transaction commits.

Decision: Slice 0 does not add an in-progress row and does not expose an idempotency HTTP route. `writeIdempotency` inserts the final result in the caller transaction. The same fingerprint replays that result. A different fingerprint leaves the stored row unchanged and fails. Two organizations do not share keys because the primary key includes `organization_id`. A later slice may add a forward migration if it proves an update is required.

Contract check: database tests cover replay, hash mismatch, and cross-organization keys against the shipped function.
