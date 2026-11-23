#!/usr/bin/env bash
# Compose-level checks for packages/mcp/docker-compose.phala.yml that need Docker. No secrets and no ingest: dummy
# values only. The shipper runs either without a token, or with a DUMMY token and no network at all (network_mode
# none), so nothing can be sent anywhere. Pulls the pinned sidecar image. test-shipper.sh covers the Vector config
# and the entrypoint logic without Docker.
#   1. `docker compose config` accepts the file with the token unset, empty and set.
#   2. Without a token the sidecar container starts, stays running, prints the one disabled line and runs `tail`, not Vector.
#   3. With a dummy token and no network the sidecar starts Vector. The token stays out of every argument list because the
#      printf that writes it is a builtin of the shell that runs the entrypoint (checked); a scan of the running
#      argument lists is supporting evidence only.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
compose="${here}/../docker-compose.phala.yml"
work="$(mktemp -d -p "${TMPDIR:-/tmp}")"
project="mcplogshipsmoke$$"
offline_project="${project}off"

fail() { echo "FAIL: $*" >&2; exit 1; }

export TINYCLOUD_MCP_IMAGE="example.invalid/tinycloud-mcp:smoke"
export TC_MCP_STATE_SECRET="smoke-state-secret-smoke-state-secret"
export TC_MCP_INTROSPECTION_CLIENT_ID="smoke"
export TC_MCP_INTROSPECTION_CLIENT_SECRET="smoke"
export CLOUDFLARE_API_TOKEN="smoke"
export CERTBOT_EMAIL="smoke@example.invalid"
export DSTACK_GATEWAY_DOMAIN="example.invalid"

compose_cmd() { docker compose -p "${project}" -f "${compose}" "$@"; }
dummy="dummy-token-smoke-only-$$"
offline_cmd() { BETTERSTACK_SOURCE_TOKEN="${dummy}" docker compose -p "${offline_project}" -f "${work}/offline.json" "$@"; }

cleanup() {
  compose_cmd down --volumes --remove-orphans >/dev/null 2>&1 || true
  if [ -f "${work}/offline.json" ]; then offline_cmd down --volumes --remove-orphans >/dev/null 2>&1 || true; fi
  rm -rf "${work}"
}
trap cleanup EXIT

# --- 1. the file renders for all three token states ---
unset BETTERSTACK_SOURCE_TOKEN
compose_cmd config -q || fail "compose config failed with the token unset"
BETTERSTACK_SOURCE_TOKEN="" compose_cmd config -q || fail "compose config failed with an empty token"
BETTERSTACK_SOURCE_TOKEN="placeholder" compose_cmd config -q || fail "compose config failed with a token"
compose_cmd config --format json | jq -e '.services.vector.environment.BETTERSTACK_SOURCE_TOKEN == ""' >/dev/null \
  || fail "an unset token must render as an empty value, not an error"

# --- 2. the sidecar idles without a token ---
compose_cmd up -d --no-deps vector
seen=""
for _ in $(seq 1 30); do
  if compose_cmd logs --no-log-prefix vector 2>&1 | grep -qx 'log shipping disabled: no source token'; then seen=yes; break; fi
  sleep 1
done
[ -n "${seen}" ] || fail "the sidecar did not print the disabled line"
compose_cmd ps --status running --services | grep -qx vector || fail "the sidecar is not running"
# `comm` is the executable name: the container's PID 1 argument list carries the whole script text, so a match on
# arguments would also hit text that is never run.
names="$(compose_cmd exec -T vector ps -o comm)"
grep -qw tail <<<"${names}" || fail "the idle process is not running"
if grep -qw vector <<<"${names}"; then fail "Vector is running without a token"; fi
compose_cmd down --volumes --remove-orphans

# --- 3. a dummy token and no network: Vector starts, and the token is in no argument list ---
BETTERSTACK_SOURCE_TOKEN="${dummy}" compose_cmd config --format json \
  | jq '.services.vector.network_mode = "none" | del(.networks, .services.vector.networks, .services.vector.ports)' \
  >"${work}/offline.json"
jq -e '.services.vector.network_mode == "none" and (.services.vector | has("ports") | not)' "${work}/offline.json" >/dev/null \
  || fail "the offline variant still has a network or a published port"
offline_cmd up -d --no-deps vector
started=""
for _ in $(seq 1 30); do
  if names="$(offline_cmd exec -T vector ps -o comm 2>/dev/null)" && grep -qw vector <<<"${names}"; then started=yes; break; fi
  sleep 1
done
[ -n "${started}" ] || fail "Vector did not start with a dummy token"
offline_cmd ps --status running --services | grep -qx vector || fail "the sidecar is not running with a dummy token"
# The proof: printf is a builtin of the very shell that runs the entrypoint. Builtin status is per shell, so the
# entrypoint must be exactly the shell asked below, and the token file must be written by a bare `printf`.
shell="$(jq -r '.services.vector.entrypoint[0]' "${work}/offline.json")"
jq -e --arg shell "${shell}" '.services.vector.entrypoint == [$shell, "-ec"]' "${work}/offline.json" >/dev/null \
  || fail "the sidecar entrypoint is not a shell run with -ec"
# shellcheck disable=SC2016  # the dollar signs are literal text of the compose source
grep -Eq '^ +printf .%s. "\$\$BETTERSTACK_SOURCE_TOKEN" > /var/lib/vector/secrets/bs_token$' "${compose}" \
  || fail "the token file is not written by a bare printf"
builtin="$(offline_cmd exec -T vector "${shell}" -ec 'type printf')"
grep -q 'shell builtin' <<<"${builtin}" || fail "printf is not a builtin of ${shell}: ${builtin}"
# Supporting evidence only, not proof: a printf that is an external command would exit before this sample.
if offline_cmd exec -T vector ps -o args | grep -qF -- "${dummy}"; then
  fail "the token appears in a process argument list"
fi
echo "compose smoke passed"
