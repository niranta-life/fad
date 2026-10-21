#!/usr/bin/env bash
# Execute against a RUNNING, provisioned FAD API. This is a test specification,
# not a claim that a Slice 1 service has been implemented here.
set -euo pipefail
: "${FAD_URL:?Set FAD_URL, e.g. http://localhost:8080}"
: "${FAD_KEY_A:?Organization A key required}"
: "${FAD_KEY_B:?Organization B key required}"
: "${FAD_OWNER_A:?Existing active Slice 0 principal UUID belonging to organization A required}"
command -v jq >/dev/null || { echo 'jq required'; exit 2; }
command -v node >/dev/null || { echo 'Node.js required'; exit 2; }
RUN_ID="$(node -e 'process.stdout.write(require("crypto").randomUUID())')"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
printf '{"name":"AP Agent %s","description":"Production registration smoke test","owner_principal_id":"%s"}' "$RUN_ID" "$FAD_OWNER_A" > "$TMP/create.json"
function call_api() {
  local method="$1" path="$2" key="$3" datafile="$4" idem="$5" match="$6" expected="$7"
  local args=(-sS -X "$method" -D "$TMP/headers" -o "$TMP/body" -w '%{http_code}' -H "X-FAD-API-Key: $key")
  if [ "$datafile" != '-' ]; then args+=(-H 'Content-Type: application/json' --data-binary "@$datafile"); fi
  if [ "$idem" != '-' ]; then args+=(-H "Idempotency-Key: $idem"); fi
  if [ "$match" != '-' ]; then args+=(-H "If-Match: $match"); fi
  local status
  status="$(curl "${args[@]}" "$FAD_URL$path")"
  if [ "$status" != "$expected" ]; then
    echo "FAIL $method $path: expected $expected got $status"
    jq -c '{error:.error}' "$TMP/body" 2>/dev/null || true
    exit 1
  fi
}
get_etag() {
  grep -i '^etag:' "$TMP/headers" | tail -1 | tr -d '\r' | cut -d' ' -f2-
}
call_api POST /v1/agents "$FAD_KEY_A" "$TMP/create.json" "smoke-create-$RUN_ID" - 201
ID="$(jq -r '.data.id' "$TMP/body")"
[ -n "$ID" ] && [ "$ID" != null ] || { echo 'Missing ID'; exit 1; }
REV="$(jq -r '.data.revision' "$TMP/body")"
[ "$REV" = 1 ] || { echo 'Expected revision=1'; exit 1; }
ETAG="$(get_etag)"
[ "$ETAG" = '"agent-v1"' ] || { echo 'Expected ETag "agent-v1"'; exit 1; }
# Identical retry must return same created resource, even if its status remains 201.
call_api POST /v1/agents "$FAD_KEY_A" "$TMP/create.json" "smoke-create-$RUN_ID" - 201
[ "$(jq -r '.data.id' "$TMP/body")" = "$ID" ] || { echo 'Duplicate registration'; exit 1; }
# No existence disclosure across organizations.
call_api GET "/v1/agents/$ID" "$FAD_KEY_B" - - - 404
call_api GET "/v1/agents/$ID" "$FAD_KEY_A" - - - 200
ETAG="$(get_etag)"
call_api GET '/v1/agents?limit=1&status=active' "$FAD_KEY_A" - - - 200
jq -e '.data|type=="array"' "$TMP/body" >/dev/null
# Update metadata; old strong ETag must no longer work.
echo '{"description":"Updated by smoke test"}' > "$TMP/patch.json"
call_api PATCH "/v1/agents/$ID" "$FAD_KEY_A" "$TMP/patch.json" "smoke-update-$RUN_ID" "$ETAG" 200
[ "$(jq -r '.data.revision' "$TMP/body")" = 2 ] || exit 1
call_api PATCH "/v1/agents/$ID" "$FAD_KEY_A" "$TMP/patch.json" "smoke-update-stale-$RUN_ID" "$ETAG" 412
ETAG="$(get_etag)" # stale response need not include ETag; reacquire below
call_api GET "/v1/agents/$ID" "$FAD_KEY_A" - - - 200
ETAG="$(get_etag)"
echo '{"reason":"Smoke test suspension"}' > "$TMP/suspend.json"
call_api POST "/v1/agents/$ID/suspend" "$FAD_KEY_A" "$TMP/suspend.json" "smoke-suspend-$RUN_ID" "$ETAG" 200
[ "$(jq -r '.data.status' "$TMP/body")" = suspended ] || exit 1
ETAG="$(get_etag)"
echo '{"reason":"Smoke test reactivation"}' > "$TMP/activate.json"
call_api POST "/v1/agents/$ID/activate" "$FAD_KEY_A" "$TMP/activate.json" "smoke-activate-$RUN_ID" "$ETAG" 200
[ "$(jq -r '.data.status' "$TMP/body")" = active ] || exit 1
ETAG="$(get_etag)"
echo '{"reason":"End of smoke test"}' > "$TMP/retire.json"
call_api POST "/v1/agents/$ID/retire" "$FAD_KEY_A" "$TMP/retire.json" "smoke-retire-$RUN_ID" "$ETAG" 200
[ "$(jq -r '.data.status' "$TMP/body")" = retired ] || exit 1
ETAG="$(get_etag)"
call_api POST "/v1/agents/$ID/activate" "$FAD_KEY_A" "$TMP/activate.json" "smoke-reactivate-$RUN_ID" "$ETAG" 409
printf 'PASS: registration, replay, cross-tenant hiding, read/list, update, stale ETag, suspend, activate, retire, terminal state. Agent ID: %s\n' "$ID"
