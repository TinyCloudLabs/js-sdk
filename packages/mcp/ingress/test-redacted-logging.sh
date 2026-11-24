#!/usr/bin/env bash
# TC-4260 (the node's TC-970 test, for the connector): run the dstack-ingress service exactly as
# packages/mcp/docker-compose.phala.yml defines it (pinned image, its `command`), with the server block the image's
# own entrypoint generates, a self-signed certificate and a fake connector. Send requests carrying approval links,
# tokens and identifiers from a separate client container, and check that none of them, nor the client address,
# reaches the ingress container's stdout/stderr or any file under /var/log/nginx; that each request is logged as one
# JSON line by method, route class and status; and that the compose bounds the container's Docker log.
# No secrets, no network beyond pulling the pinned image.
#
# Usage: packages/mcp/ingress/test-redacted-logging.sh
#   DOCKER=...    docker command (default: docker; for example DOCKER="sudo docker")
set -euo pipefail

DOCKER=${DOCKER:-docker}
HERE=$(cd "$(dirname "$0")" && pwd)
COMPOSE="$HERE/../docker-compose.phala.yml"
RUN_ID="tc4260-mcp-ingress-logtest-$$-$RANDOM"
NETWORK="$RUN_ID"
INGRESS="$RUN_ID-ingress"
CLIENT="$RUN_ID-client"
WORK=$(mktemp -d -p "${TMPDIR:-/tmp}")

cleanup() {
    $DOCKER rm -f "$INGRESS" "$CLIENT" >/dev/null 2>&1 || true
    $DOCKER network rm "$NETWORK" >/dev/null 2>&1 || true
    rm -rf "$WORK"
}
trap cleanup EXIT

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

# --- the service as deployed: render the compose file with dummy values ---
cat >"$WORK/dummy.env" <<'EOF'
TINYCLOUD_MCP_IMAGE=example.invalid/tinycloud-mcp:logtest
TC_MCP_STATE_SECRET=logtest-state-secret-logtest-state-secret
TC_MCP_INTROSPECTION_CLIENT_ID=logtest
TC_MCP_INTROSPECTION_CLIENT_SECRET=logtest
CLOUDFLARE_API_TOKEN=logtest
CERTBOT_EMAIL=logtest@example.invalid
DSTACK_GATEWAY_DOMAIN=example.invalid
EOF
$DOCKER compose -p "$RUN_ID" -f "$COMPOSE" --env-file "$WORK/dummy.env" config --format json >"$WORK/compose.json"
jq '.services["dstack-ingress"]' "$WORK/compose.json" >"$WORK/ingress.json"
IMAGE=$(jq -r '.image' "$WORK/ingress.json")
case "$IMAGE" in *@sha256:*) ;; *) fail "the ingress image is not pinned by digest: $IMAGE" ;; esac
jq -e '.command | type == "array" and length > 0' "$WORK/ingress.json" >/dev/null || fail "the ingress service has no command"
# `config` prints `$$` escaped; compose passes it to the container as `$`.
mapfile -d '' COMMAND < <(jq -j '.command[] | gsub("\\$\\$"; "$"), "\u0000"' "$WORK/ingress.json")
# The size bound: the access log goes to stdout, so the Docker log must be capped.
jq -e '.logging.driver == "json-file" and (.logging.options["max-size"] | test("^[0-9]+[km]$"))
       and (.logging.options["max-file"] | test("^[0-9]+$"))' "$WORK/ingress.json" >/dev/null \
    || fail "the ingress Docker log is not a capped json-file log: $(jq -c '.logging' "$WORK/ingress.json")"
echo "testing $IMAGE with the compose command"

hex() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }
STATE="tc4260state$(hex 12)"
QUERY_TOKEN="tc4260querytoken$(hex 12)"
PATH_MARKER="tc4260path$(hex 12)"
BEARER="tc4260bearer$(hex 12)"
SERVICE_CREDENTIAL="tc4260servicecred$(hex 12)"
DELEGATION="tc4260delegation$(hex 12)"
FORWARDED_IP="198.51.100.$((RANDOM % 200 + 20))"
USER_AGENT="tc4260agent$(hex 12)"
REFERER_MARKER="tc4260referer$(hex 12)"
# nginx accepts only A-Z, `_` and `-` in a method.
METHOD="TCMETHOD$(hex 8 | tr '0-9a-f' 'GHIJKLMNOPQRSTUV')"
DOMAIN="mcp-ingress-logtest.local"

# Inside the ingress container: a self-signed certificate where the entrypoint expects the Let's Encrypt one, the
# entrypoint's own setup_nginx_conf, and a fake connector on 127.0.0.1:8000; then the compose command, as the image's
# entrypoint would run it. /native/ is routed to a closed port so nginx's upstream-error path runs; that path writes
# the request line and the client address to the error log.
INGRESS_SETUP='
set -eo pipefail
mkdir -p "/etc/letsencrypt/live/$DOMAIN"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=$DOMAIN" \
    -keyout "/etc/letsencrypt/live/$DOMAIN/privkey.pem" \
    -out "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" 2>/dev/null
PROXY_CMD=proxy
# setup_nginx_conf runs up to the next function; its heredoc has a column-0 "}".
eval "$(sed -n "/^setup_nginx_conf() {/,/^set_alias_record() {/p" /scripts/entrypoint.sh | sed "\$d")"
setup_nginx_conf
sed -i "s#^    location / {#    location /native/ {\n        proxy_pass http://127.0.0.1:9;\n    }\n\n    location / {#" \
    /etc/nginx/conf.d/default.conf
cat >/etc/nginx/conf.d/zz-fake-mcp.conf <<EOF
server {
    listen 127.0.0.1:8000;
    access_log off;
    location = /connect { return 302 https://openkey.example/approve; }
    location / { return 200 "ok\n"; }
}
EOF
exec "$@"
'

$DOCKER network create "$NETWORK" >/dev/null
$DOCKER run -d --name "$INGRESS" --network "$NETWORK" \
    -e DOMAIN="$DOMAIN" -e PORT=443 -e TARGET_ENDPOINT=http://127.0.0.1:8000 \
    --entrypoint /bin/bash "$IMAGE" -c "$INGRESS_SETUP" ingress-setup "${COMMAND[@]}" >/dev/null
$DOCKER run -d --name "$CLIENT" --network "$NETWORK" --entrypoint sleep "$IMAGE" infinity >/dev/null

ip_of() {
    $DOCKER inspect -f "{{(index .NetworkSettings.Networks \"$NETWORK\").IPAddress}}" "$1"
}
INGRESS_IP=$(ip_of "$INGRESS")
CLIENT_IP=$(ip_of "$CLIENT")
[ -n "$INGRESS_IP" ] && [ -n "$CLIENT_IP" ] || fail "no container addresses"

# Prints the HTTP status of one request sent from the client container.
request() {
    $DOCKER exec "$CLIENT" curl -sk -o /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 30 \
        --resolve "$DOMAIN:443:$INGRESS_IP" \
        -H "Authorization: Bearer $BEARER" \
        -H "X-TinyCloud-Service-Credential: $SERVICE_CREDENTIAL" \
        -H "X-Forwarded-For: $FORWARDED_IP" \
        -H "User-Agent: $USER_AGENT" \
        -H "Referer: https://chatgpt.example/c/$REFERER_MARKER" \
        "$@"
}

ready=""
for _ in $(seq 1 50); do
    if [ "$(request "https://$DOMAIN/healthz" || true)" = "200" ]; then
        ready=1
        break
    fi
    sleep 0.2
done
[ -n "$ready" ] || { $DOCKER logs "$INGRESS" >&2 || true; fail "ingress did not become ready"; }

expect_status() {
    local want=$1 got
    shift
    got=$(request "$@")
    [ "$got" = "$want" ] || fail "expected $want, got $got for: ${*: -1}"
}

# An approval link, over HTTP/2 and HTTP/1.1, and with a client-chosen method.
expect_status 302 "https://$DOMAIN/connect?state=$STATE"
expect_status 302 --http1.1 "https://$DOMAIN/connect?state=$STATE"
expect_status 302 --http1.1 -X "$METHOD" "https://$DOMAIN/connect?state=$STATE"
# A path the map does not know, carrying a marker.
expect_status 200 "https://$DOMAIN/connect/$PATH_MARKER"
# A regex route class (its `$$` anchor must reach nginx as `$`).
expect_status 200 "https://$DOMAIN/.well-known/agent-skills/tinycloud-delegated-secrets/SKILL.md"
expect_status 200 -X POST -H "Content-Type: application/json" --data "{\"token\":\"$QUERY_TOKEN\"}" \
    "https://$DOMAIN/mcp?token=$QUERY_TOKEN"
# The upstream is down: nginx's error path (request line and client address) runs.
expect_status 502 -X POST -H "Content-Type: application/json" --data "{\"delegation\":\"$DELEGATION\"}" \
    "https://$DOMAIN/native/grant?state=$STATE"
# Refused before routing: a request line over nginx's 8 KiB buffers, with the approval link in it.
expect_status 414 --http1.1 "https://$DOMAIN/connect?state=$STATE&pad=$(head -c 9000 /dev/zero | tr '\0' a)"

sleep 1
LOGS=$($DOCKER logs "$INGRESS" 2>&1)
FILES=$($DOCKER exec "$INGRESS" sh -c 'find /var/log/nginx -type f -exec cat {} +' 2>&1)

for pair in \
    "approval state=$STATE" \
    "query token=$QUERY_TOKEN" \
    "path marker=$PATH_MARKER" \
    "bearer token=$BEARER" \
    "service credential=$SERVICE_CREDENTIAL" \
    "delegation=$DELEGATION" \
    "client address=$CLIENT_IP" \
    "X-Forwarded-For address=$FORWARDED_IP" \
    "User-Agent=$USER_AGENT" \
    "Referer=$REFERER_MARKER" \
    "request method=$METHOD"; do
    what=${pair%%=*}
    needle=${pair#*=}
    if grep -F -- "$needle" <<<"$LOGS" >&2; then
        fail "the $what reached the ingress container's stdout/stderr (lines above)"
    fi
    if grep -F -- "$needle" <<<"$FILES" >&2; then
        fail "the $what reached a file under /var/log/nginx (lines above)"
    fi
done

LOG_FILES=$($DOCKER exec "$INGRESS" find /var/log/nginx -type f -size +0c)
[ -z "$LOG_FILES" ] || { $DOCKER exec "$INGRESS" sh -c "head -c 2000 $LOG_FILES" >&2; fail "nginx wrote to unrotated log files: $LOG_FILES"; }

# Every access line is valid JSON with the expected fields, and each request is logged by method, route class and status.
ACCESS=$(grep '^{' <<<"$LOGS" | jq -er '
    if (.status | type) == "number" and (.bytes | type) == "number" and (.request_time | type) == "number"
       and ([.time, .method, .route, .protocol, .upstream_status, .upstream_connect_time, .upstream_response_time]
            | all(type == "string"))
    then "\(.method) \(.route) \(.status)" else error("unexpected access log line: \(.)") end') \
    || { echo "$LOGS" >&2; fail "an access log line is not the expected JSON"; }
expect_line() {
    [ "$(grep -cxF "$2" <<<"$ACCESS")" = "$1" ] \
        || { echo "$ACCESS" >&2; fail "expected $1 access log line(s): $2"; }
}
expect_line 2 "GET /connect 302"
expect_line 1 "<other> /connect 302"
expect_line 1 "GET <other> 200"
expect_line 1 "GET /.well-known/agent-skills/<skill>/SKILL.md 200"
expect_line 1 "POST /mcp 200"
expect_line 1 "POST /native/grant 502"
# nginx refuses the oversized request line before it parses the method or path.
expect_line 1 "<other> <other> 414"

echo "ingress container output:"
sed 's/^/  /' <<<"$LOGS"
echo "PASS: no approval link, token, identifier, header or client address in the ingress logs; no nginx log files; Docker log capped"
