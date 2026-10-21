#!/usr/bin/env bash
# Execute only against an intentionally provisioned test organization/agent.
# Requires curl, jq, openssl. No sensitive request headers printed.
set -euo pipefail
: "${FAD_URL:?Set FAD_URL (e.g. http://localhost:3000)}"
: "${FAD_AGENT_ID:?Set FAD_AGENT_ID to an agent in the test organization}"
: "${FAD_ADMIN_KEY:?Set FAD_ADMIN_KEY with tags:define,tags:write,tags:governance,tags:read,tags:restricted:read,agents:read}"
: "${FAD_EDITOR_KEY:?Set FAD_EDITOR_KEY with tags:write,tags:read,agents:read but NO tags:governance}"
: "${FAD_READER_KEY:?Set FAD_READER_KEY with agents:read,tags:read but NO tags:restricted:read}"
command -v curl >/dev/null && command -v jq >/dev/null && command -v openssl >/dev/null
FAD_URL="${FAD_URL%/}"
TEMP_DIR="$(mktemp -d)"; trap 'rm -rf "$TEMP_DIR"' EXIT
RUN_ID="s$(openssl rand -hex 5)"
NORMAL_NS="${RUN_ID}"
GOV_KEY="risk_${RUN_ID}"
HEADER_FILE="$TEMP_DIR/headers"; BODY_FILE="$TEMP_DIR/body"
request() {
  local method="$1" url="$2" key="$3"; shift 3
  CODE="$(curl --silent --show-error --dump-header "$HEADER_FILE" --output "$BODY_FILE" --write-out '%{http_code}' \
    --request "$method" --header "X-FAD-API-Key: $key" "$FAD_URL$url" "$@")"
  BODY="$(cat "$BODY_FILE")"
  ETAG="$(awk 'BEGIN{IGNORECASE=1} tolower($1)=="etag:" {gsub("\r", "", $2); print $2}' "$HEADER_FILE" | tail -n 1)"
  printf '%s %s -> %s\n' "$method" "$url" "$CODE"
}
expect_code(){ if [[ "$CODE" != "$1" ]]; then echo "FAIL expected $1 got $CODE; response: $BODY" >&2; exit 1; fi; }
expect_json(){ if ! jq -e "$1" <<< "$BODY" >/dev/null; then echo "FAIL JSON predicate $1: $BODY" >&2; exit 1; fi; }

# Confirm target agent exists and remember parent ETag.
request GET "/v1/agents/$FAD_AGENT_ID" "$FAD_READER_KEY"; expect_code 200
AGENT_ETAG="$ETAG"; [[ "$AGENT_ETAG" == '"agent-v'* ]] || { echo 'FAIL no parent ETag' >&2; exit 1; }

# Normal string tag definition; exact business envelope.
request POST /v1/tag-definitions "$FAD_ADMIN_KEY" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: smoke-def-$RUN_ID" \
  --data "{\"namespace\":\"$NORMAL_NS\",\"key\":\"team\",\"value_type\":\"string\",\"governed\":false,\"visibility\":\"internal\"}"
expect_code 201; expect_json ".data.namespace == \"$NORMAL_NS\" and .data.governed == false"

# Security namespace definition governed/restricted. Random key avoids collisions.
request POST /v1/tag-definitions "$FAD_ADMIN_KEY" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: smoke-govdef-$RUN_ID" \
  --data "{\"namespace\":\"security\",\"key\":\"$GOV_KEY\",\"value_type\":\"enum\",\"enum_values\":[\"low\",\"medium\",\"high\"],\"governed\":true,\"visibility\":\"restricted\"}"
expect_code 201

TAG_PATH="/v1/agents/$FAD_AGENT_ID/tags/$NORMAL_NS/team"
request PUT "$TAG_PATH" "$FAD_EDITOR_KEY" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: smoke-assignment-$RUN_ID" -H 'If-None-Match: *' --data '{"value":"finance"}'
expect_code 201; [[ "$ETAG" == '"tag-v1"' ]] || { echo 'FAIL wrong first ETag' >&2; exit 1; }
request GET "$TAG_PATH" "$FAD_READER_KEY"; expect_code 200; expect_json '.data.value == "finance" and .data.revision == 1'

# Parent ETag must not be updated by tag writes.
request GET "/v1/agents/$FAD_AGENT_ID" "$FAD_READER_KEY"; expect_code 200
[[ "$ETAG" == "$AGENT_ETAG" ]] || { echo 'FAIL parent Agent ETag changed' >&2; exit 1; }

request POST /v1/agents/search "$FAD_READER_KEY" -H 'Content-Type: application/json' \
  --data "{\"tags\":[{\"namespace\":\"$NORMAL_NS\",\"key\":\"team\",\"operator\":\"eq\",\"value\":\"finance\"}],\"limit\":25}"
expect_code 200; expect_json ".data | any(.id == \"$FAD_AGENT_ID\")"

GOV_PATH="/v1/agents/$FAD_AGENT_ID/tags/security/$GOV_KEY"
request PUT "$GOV_PATH" "$FAD_EDITOR_KEY" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: smoke-deny-$RUN_ID" -H 'If-None-Match: *' --data '{"value":"low","reason":"Attempted downgrade"}'
expect_code 403
request PUT "$GOV_PATH" "$FAD_ADMIN_KEY" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: smoke-govassign-$RUN_ID" -H 'If-None-Match: *' --data '{"value":"high","reason":"Security review"}'
expect_code 201
request GET "$GOV_PATH" "$FAD_READER_KEY"; expect_code 404
request POST /v1/agents/search "$FAD_READER_KEY" -H 'Content-Type: application/json' \
  --data "{\"tags\":[{\"namespace\":\"security\",\"key\":\"$GOV_KEY\",\"operator\":\"eq\",\"value\":\"high\"}]}"
expect_code 403

# Update and stale version test.
request PUT "$TAG_PATH" "$FAD_EDITOR_KEY" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: smoke-update-$RUN_ID" -H 'If-Match: "tag-v1"' --data '{"value":"accounts-payable"}'
expect_code 200; [[ "$ETAG" == '"tag-v2"' ]] || { echo 'FAIL incorrect revision after update' >&2; exit 1; }
request PUT "$TAG_PATH" "$FAD_EDITOR_KEY" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: smoke-stale-$RUN_ID" -H 'If-Match: "tag-v1"' --data '{"value":"finance"}'
expect_code 412
request DELETE "$TAG_PATH" "$FAD_EDITOR_KEY" -H "Idempotency-Key: smoke-delete-$RUN_ID" -H 'If-Match: "tag-v2"'
expect_code 204
request GET "$TAG_PATH" "$FAD_READER_KEY"; expect_code 404
request PUT "$TAG_PATH" "$FAD_EDITOR_KEY" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: smoke-reassign-$RUN_ID" -H 'If-None-Match: *' --data '{"value":"finance"}'
expect_code 201; [[ "$ETAG" == '"tag-v4"' ]] || { echo "FAIL ABA: expected tag-v4, got $ETAG" >&2; exit 1; }

printf '\nPASS: core Slice 2 real HTTP journey and safety checks.\n'
printf 'Use TEST_MATRIX.md for the full production gate (including DB RLS, concurrency, failure injection and SDK).\n'
