#!/usr/bin/env sh
set -eu

[ "$#" = 1 ] || { echo "usage: $0 BASE_URL" >&2; exit 2; }
command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 1; }

base=${1%/}
tmp=$(mktemp -d "${TMPDIR:-/tmp}/btga-master-test.XXXXXX")
lobby_id=
host_secret=

cleanup() {
    if [ -n "$lobby_id" ] && [ -n "$host_secret" ]; then
        curl -sS --max-time 30 -X DELETE \
            -H "authorization: Bearer $host_secret" \
            "$base/lobbies/$lobby_id" >/dev/null || true
    fi
    rm -rf -- "$tmp"
}
trap cleanup EXIT HUP INT TERM

request() {
    expected=$1
    output=$2
    shift 2
    actual=$(curl -sS --max-time 30 -o "$output" -w '%{http_code}' "$@")
    if [ "$actual" != "$expected" ]; then
        echo "expected HTTP $expected, received $actual" >&2
        jq '{error,message}' "$output" 2>/dev/null || true
        exit 1
    fi
}

request 200 "$tmp/health.json" "$base/health"
jq -e '.status=="ok" and .protocol==1' "$tmp/health.json" >/dev/null

request 201 "$tmp/register.json" \
    -H 'content-type: application/json' \
    --data '{"name":"API conformance test","protocol":1,"build":"conformance-v1","platform":"pc","capabilities":3,"region":"test","max_players":4,"current_players":1,"udp_port":30420}' \
    "$base/lobbies"
lobby_id=$(jq -r '.lobby.id' "$tmp/register.json")
host_secret=$(jq -r '.host_secret' "$tmp/register.json")
registered_session_id=$(jq -r '.session_id' "$tmp/register.json")
test -n "$lobby_id" && test -n "$host_secret"
printf '%s' "$registered_session_id" | grep -Eq '^[0-9a-f]{16}$'

request 200 "$tmp/list.json" "$base/lobbies?protocol=1&build=conformance-v1"
jq -e --arg id "$lobby_id" '.lobbies|any(.id==$id)' "$tmp/list.json" >/dev/null

request 200 "$tmp/heartbeat.json" \
    -X PUT -H 'content-type: application/json' \
    -H "authorization: Bearer $host_secret" \
    --data '{"current_players":2}' \
    "$base/lobbies/$lobby_id/heartbeat"
jq -e '.current_players==2' "$tmp/heartbeat.json" >/dev/null

request 200 "$tmp/join.json" \
    -H 'content-type: application/json' \
    --data '{"protocol":1,"build":"conformance-v1","platform":"vita"}' \
    "$base/lobbies/$lobby_id/join"
join_token=$(jq -r '.join_token' "$tmp/join.json")
session_id=$(jq -r '.session_id' "$tmp/join.json")
test -n "$join_token" && test "$session_id" = "$registered_session_id"

request 200 "$tmp/validate.json" \
    -H 'content-type: application/json' \
    -H "authorization: Bearer $host_secret" \
    --data "{\"join_token\":\"$join_token\"}" \
    "$base/lobbies/$lobby_id/validate-join"
jq -e --arg session "$registered_session_id" \
    '.valid==true and .claims.platform=="vita" and .claims.session==$session' \
    "$tmp/validate.json" >/dev/null

request 204 "$tmp/delete.txt" \
    -X DELETE -H "authorization: Bearer $host_secret" \
    "$base/lobbies/$lobby_id"
lobby_id=
host_secret=

echo "master API lifecycle passed"
