#!/usr/bin/env bash
# FAD Slice 3 real HTTP smoke. Does not create fake evidence.
# Requires jq, curl, mktemp, bash and a running Slice 0–3 implementation.
# Org A agent must be active and have active department.name=finance tag.
set -Eeuo pipefail
: "${FAD_URL:?set base URL, e.g. https://fad.internal.example}"
: "${FAD_API_KEY:?org A key with agents:read,capabilities:read/write,endpoints:read/write,tags:read}"
: "${FAD_AGENT_ID:?existing active org A agent UUID with department.name=finance tag}"
: "${FAD_TENANT_B_API_KEY:?org B read credential for negative isolation proof}"
FAD_URL="${FAD_URL%/}"
command -v jq >/dev/null
command -v curl >/dev/null
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
RUN="$(date -u +%Y%m%d%H%M%S)-$$"
CAP="finance.invoice.match_${RUN//[^0-9]/}"
PATH_ENDPOINT="/v1/agents/$FAD_AGENT_ID/endpoints/primary"
PATH_BINDING="/v1/agents/$FAD_AGENT_ID/capabilities/$CAP"
http() {
  local method="$1" path="$2" key="$3" content="${4-}"; shift 4 || true
  local args=(-sS -X "$method" -D "$T/headers" -o "$T/body" -w '%{http_code}' \
    -H "X-FAD-API-Key: $key" -H 'Accept: application/json')
  if [[ -n "$content" ]]; then args+=(-H 'Content-Type: application/json' --data "$content"); fi
  while (( $# )); do args+=(-H "$1"); shift; done
  CODE="$(curl "${args[@]}" "$FAD_URL$path")"
  # DO NOT echo API key or secrets. Display statuses only.
}
expect() { [[ "$CODE" == "$1" ]] || { printf 'FAIL expected HTTP %s, got %s: %s\n' "$1" "$CODE" "$(jq -c '{error:.error}' "$T/body" 2>/dev/null || echo '<non-json>')" >&2; exit 1; }; }
json_has() { jq -e "$1" "$T/body" >/dev/null || { echo "ASSERT failed: $1" >&2; exit 1; }; }
etag() { sed -n 's/^[Ee][Tt][Aa][Gg]:[[:space:]]*\(.*\)\r\?$/\1/p' "$T/headers" | tail -1 | tr -d '\r'; }
printf 'Slice 3 acceptance smoke starting (run %s)\n' "$RUN"
PUBLISH=$(jq -nc --arg id "$CAP" '{id:$id,version:"1.0.0",display_name:"Invoice matching",description:"Compare invoice and PO",input_schema:{type:"object",properties:{invoice_id:{type:"string"}},required:["invoice_id"],additionalProperties:false},output_schema:{type:"object",properties:{matched:{type:"boolean"}},required:["matched"],additionalProperties:false}}')
http POST '/v1/capabilities' "$FAD_API_KEY" "$PUBLISH" "Idempotency-Key: slice3-publish-$RUN"; expect 201; json_has '.data.verification=="self_declared"'; echo 'PASS publish'
http GET "/v1/capabilities/$CAP/versions/1.0.0" "$FAD_API_KEY"; expect 200; jq -e --arg id "$CAP" '.data.id==$id' "$T/body" >/dev/null; echo 'PASS get capability'
http PUT "$PATH_ENDPOINT" "$FAD_API_KEY" '{"protocol":"a2a","url":"https://ap.internal.example/a2a","auth_scheme":"oauth2","enabled":true}' "If-None-Match: *" "Idempotency-Key: slice3-endpoint-$RUN"; expect 201; ENDPOINT_ETAG="$(etag)"; [[ "$ENDPOINT_ETAG" == '"endpoint-v1"' ]] || exit 1; echo 'PASS endpoint'
http PUT "$PATH_BINDING" "$FAD_API_KEY" "$(jq -nc '{version:"1.0.0",endpoint_key:"primary"}')" 'If-None-Match: *' "Idempotency-Key: slice3-binding-$RUN"; expect 201; BINDING_ETAG="$(etag)"; [[ "$BINDING_ETAG" == '"cap-binding-v1"' ]] || exit 1; echo 'PASS binding'
FILTER=$(jq -nc --arg id "$CAP" '{capability:{id:$id,version:"1.0.0"},tags:[{namespace:"department",key:"name",operator:"eq",value:"finance"}],protocols:["a2a"],limit:25}')
http POST /v1/discovery/agents "$FAD_API_KEY" "$FILTER"; expect 200
# Explicit literal jq path assertion; $FAD_AGENT_ID is UUID and shell-safe here.
jq -e --arg id "$FAD_AGENT_ID" '.data | any(.agent.id==$id and .invocation_authorization=="not_evaluated" and .availability=="not_checked")' "$T/body" >/dev/null || { echo 'FAIL discovery missing agent / provenance'; exit 1; }; echo 'PASS local discovery'
http GET "$PATH_BINDING" "$FAD_TENANT_B_API_KEY"; expect 404; echo 'PASS cross-tenant binding isolation'
http GET "$PATH_ENDPOINT" "$FAD_TENANT_B_API_KEY"; expect 404; echo 'PASS cross-tenant endpoint isolation'
http POST /v1/discovery/agents "$FAD_TENANT_B_API_KEY" "$(jq -nc --arg id "$CAP" '{capability:{id:$id},limit:25}')"; expect 200
jq -e --arg id "$FAD_AGENT_ID" '[.data[].agent.id] | index($id) == null' "$T/body" >/dev/null || { echo 'FAIL remote tenant discovery leak'; exit 1; }; echo 'PASS cross-tenant discovery isolation'
http PUT "$PATH_ENDPOINT" "$FAD_API_KEY" '{"protocol":"a2a","url":"https://ap.internal.example/a2a","auth_scheme":"oauth2","enabled":false}' "If-Match: $ENDPOINT_ETAG" "Idempotency-Key: slice3-disable-$RUN"; expect 200; ENDPOINT_ETAG="$(etag)"; echo 'PASS disable endpoint'
http POST /v1/discovery/agents "$FAD_API_KEY" "$FILTER"; expect 200
jq -e --arg id "$FAD_AGENT_ID" '[.data[].agent.id] | index($id) == null' "$T/body" >/dev/null || { echo 'FAIL disabled endpoint discoverable'; exit 1; }; echo 'PASS disabled excluded'
http PUT "$PATH_ENDPOINT" "$FAD_API_KEY" '{"protocol":"a2a","url":"https://ap.internal.example/a2a","auth_scheme":"oauth2","enabled":true}' "If-Match: $ENDPOINT_ETAG" "Idempotency-Key: slice3-enable-$RUN"; expect 200; ENDPOINT_ETAG="$(etag)"
http DELETE "$PATH_ENDPOINT" "$FAD_API_KEY" '' "If-Match: $ENDPOINT_ETAG" "Idempotency-Key: slice3-delete-inuse-$RUN"; expect 409; echo 'PASS referenced endpoint guarded'
http DELETE "$PATH_BINDING" "$FAD_API_KEY" '' "If-Match: $BINDING_ETAG" "Idempotency-Key: slice3-unbind-$RUN"; expect 204; echo 'PASS unbind'
http DELETE "$PATH_ENDPOINT" "$FAD_API_KEY" '' "If-Match: $ENDPOINT_ETAG" "Idempotency-Key: slice3-delete-endpoint-$RUN"; expect 204; echo 'PASS endpoint tombstone'
http POST /v1/discovery/agents "$FAD_API_KEY" "$FILTER"; expect 200
jq -e --arg id "$FAD_AGENT_ID" '[.data[].agent.id] | index($id) == null' "$T/body" >/dev/null || { echo 'FAIL unbound agent discoverable'; exit 1; }
echo 'PASS slice3 smoke. Store a SANITIZED real output transcript under docs/releases/slice-3/api-evidence/.'
