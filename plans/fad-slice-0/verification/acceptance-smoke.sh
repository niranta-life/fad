#!/usr/bin/env bash
# Probe only. Requires implemented and running FAD API + bootstrap.
# Env: FAD_BASE_URL, FAD_TEST_A_KEY, FAD_TEST_B_KEY, FAD_TEST_A_ORG_ID,
#      FAD_TEST_B_ORG_ID, optional FAD_TEST_NOSCOPE_KEY/FAD_TEST_REVOKED_KEY.
set -euo pipefail
: "${FAD_BASE_URL:?required}"
: "${FAD_TEST_A_KEY:?required}"
: "${FAD_TEST_B_KEY:?required}"
: "${FAD_TEST_A_ORG_ID:?required}"
: "${FAD_TEST_B_ORG_ID:?required}"
for bin in jq curl mktemp; do command -v "$bin" >/dev/null || { echo "missing $bin" >&2; exit 2; }; done
[ "$FAD_TEST_A_ORG_ID" != "$FAD_TEST_B_ORG_ID" ] || { echo "test orgs must differ" >&2; exit 2; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

check() { local name="$1" expected="$2" actual="$3"; [ "$expected" = "$actual" ] || { echo "FAIL $name expected $expected got $actual" >&2; exit 1; }; echo "PASS $name"; }
request() {
  local name="$1" path="$2" key="$3" expected="$4"; shift 4
  local status
  local -a auth_args=()
  if [ -n "$key" ]; then auth_args=(-H "X-FAD-API-Key: $key"); fi
  status=$(curl --silent --show-error --connect-timeout 3 --max-time 10 \
    -D "$TMP/$name.h" -o "$TMP/$name.json" -w '%{http_code}' \
    "${auth_args[@]}" "$@" "${FAD_BASE_URL%/}$path")
  check "$name HTTP" "$expected" "$status"
  jq -e . "$TMP/$name.json" >/dev/null
}

request live /health/live '' 200
check 'liveness body' ok "$(jq -r '.status' "$TMP/live.json")"
request ready /health/ready '' 200
check 'readiness body' ready "$(jq -r '.status' "$TMP/ready.json")"
request a /v1/organizations/current "$FAD_TEST_A_KEY" 200
request b /v1/organizations/current "$FAD_TEST_B_KEY" 200
check 'org A identity' "$FAD_TEST_A_ORG_ID" "$(jq -r '.data.id' "$TMP/a.json")"
check 'org B identity' "$FAD_TEST_B_ORG_ID" "$(jq -r '.data.id' "$TMP/b.json")"
check 'api version' v1 "$(jq -r '.meta.api_version' "$TMP/a.json")"
jq -e '.meta.request_id | type=="string"' "$TMP/a.json" >/dev/null

auth_header="$(tr -d '\r' < "$TMP/a.h" | grep -i '^cache-control:' | tail -1 | cut -d: -f2- | xargs)"
check 'no-store cache' 'private, no-store' "$auth_header"

request missing /v1/organizations/current '' 401
request malformed /v1/organizations/current 'broken' 401
check 'missing error code' UNAUTHORIZED "$(jq -r '.error.code' "$TMP/missing.json")"
check 'invalid error code' UNAUTHORIZED "$(jq -r '.error.code' "$TMP/malformed.json")"
request ignore_org_header /v1/organizations/current "$FAD_TEST_A_KEY" 200 -H "X-Organization-Id: $FAD_TEST_B_ORG_ID"
check 'cannot select other organization' "$FAD_TEST_A_ORG_ID" "$(jq -r '.data.id' "$TMP/ignore_org_header.json")"
request bad_query '/v1/organizations/current?organization_id=other' "$FAD_TEST_A_KEY" 400

if [ -n "${FAD_TEST_NOSCOPE_KEY:-}" ]; then
  request no_scope /v1/organizations/current "$FAD_TEST_NOSCOPE_KEY" 403
fi
if [ -n "${FAD_TEST_REVOKED_KEY:-}" ]; then
  request revoked /v1/organizations/current "$FAD_TEST_REVOKED_KEY" 401
fi

echo 'PASS Slice 0 HTTP smoke (requires separate DB/RLS/security tests)'
