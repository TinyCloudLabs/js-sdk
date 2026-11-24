#!/usr/bin/env bash
# Tests the log shipper that packages/mcp/docker-compose.phala.yml embeds. No network, no secrets.
#   1. The embedded Vector config validates and passes tests.yaml (Vector from VECTOR_BIN, or Docker with the
#      image the compose pins).
#   2. Every allowlisted value in the config and in fields.json matches the code that can produce it.
#   3. The sidecar entrypoint idles (no Vector, no token file) without a source token, and starts Vector with a
#      private token file and no token in its environment when one is given.
# Usage: test-shipper.sh   (from anywhere)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pkgs="$(cd "${here}/../.." && pwd)"
compose="${here}/../docker-compose.phala.yml"
work="$(mktemp -d -p "${TMPDIR:-/var/tmp}")"
trap 'rm -rf "${work}"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

# --- extract the embedded text: the compose file is the only copy, Phala deploys that one file ---
sed -n "/<<'VECTOR_CONFIG'/,/^ *VECTOR_CONFIG\$/p" "${compose}" | sed '1d;$d' >"${work}/embedded.yaml"
[ -s "${work}/embedded.yaml" ] || fail "no embedded Vector config found in the compose file"
if grep -qv '^        ' "${work}/embedded.yaml"; then fail "the embedded config has a line outside the 8-space block"; fi
sed 's/^        //' "${work}/embedded.yaml" >"${work}/vector.yaml"
# Compose would interpolate a dollar sign before Vector sees it.
if grep -q '\$' "${work}/vector.yaml"; then fail "the embedded config contains a dollar sign"; fi

image="$(sed -n 's/^    image: \(timberio\/vector:[^ ]*\)$/\1/p' "${compose}")"
case "${image}" in *@sha256:*) ;; *) fail "the Vector image is not pinned by digest" ;; esac

# --- 2. allowlists match their sources ---
quoted() { grep -o '"[A-Za-z0-9_]*"' | tr -d '"'; }
vrl_array() { grep -m1 "^ *$1 = \[" "${work}/vector.yaml" | quoted; }
same_set() { # name, expected, actual
  local extra missing
  extra="$(comm -13 <(sort -u <<<"$2") <(sort -u <<<"$3") | tr '\n' ' ')"
  missing="$(comm -23 <(sort -u <<<"$2") <(sort -u <<<"$3") | tr '\n' ' ')"
  [ -z "${extra}${missing}" ] || fail "$1 drifted from its source: only in the shipper [${extra}] missing from the shipper [${missing}]"
}
upper() { tr '[:lower:]' '[:upper:]'; }

src_tools="$(sed -n '/^export const TOOL_NAMES/,/^\] as const/p' "${pkgs}/mcp/src/tools.ts" | quoted)"
grep -q '"tinycloud_connect"' "${pkgs}/mcp/src/http.ts" || fail "tinycloud_connect is no longer registered by http.ts"
src_tools="${src_tools}"$'\n'"tinycloud_connect"
src_stable="$(jq -r '.stableErrors[]' "${pkgs}/operations/generated/operations.json")"
src_client="$(sed -n '/^export type ApprovalClientErrorCode/,/;$/p' "${pkgs}/share-envelope/src/links/approval-client.ts" | grep -o '| "[a-z_]*"' | quoted)"
src_detail="$(sed -n '/^export type ApprovalRequestDetail/,/;$/p' "${pkgs}/mcp/src/remote-store.ts" | quoted)"
src_stage="$(grep '^export type ApprovalStage ' "${pkgs}/mcp/src/remote-store.ts" | quoted)"
src_delegation="$(sed -n '/^export const RUNTIME_DELEGATION_REJECTIONS/,/\] as const/p' "${pkgs}/node-sdk/src/delegation.ts" | quoted)"
for list in src_tools src_stable src_client src_detail src_stage src_delegation; do
  [ -n "${!list}" ] || fail "could not read ${list} from the source"
done

same_set "tools" "${src_tools}" "$(vrl_array tools)"
same_set "stable_codes" "${src_stable}" "$(vrl_array stable_codes)"
same_set "client_codes" "$(upper <<<"${src_client}")" "$(vrl_array client_codes)"
same_set "detail_codes" "$(upper <<<"${src_detail}")" "$(vrl_array detail_codes)"
same_set "stages" "${src_stage}"$'\n'"collect"$'\n'"owner"$'\n'"unknown" "$(vrl_array stages)"
same_set "details" "${src_detail}"$'\n'"none" "$(vrl_array details)"
same_set "connect_reasons" "${src_detail}"$'\n'"openkey_unavailable"$'\n'"unknown" "$(vrl_array connect_reasons)"
same_set "delegation_reasons" "${src_delegation}"$'\n'"unknown" "$(vrl_array delegation_reasons)"
grep -q 'openkey_unavailable' "${pkgs}/mcp/src/http.ts" || fail "openkey_unavailable is no longer a connect rejection reason"
# The remaining codes are literals in the code; each must still exist.
for code in $(vrl_array approval_codes) $(vrl_array status_codes); do
  grep -rqF "${code}" "${pkgs}/mcp/src" "${pkgs}/node-sdk/src" "${pkgs}/sdk-core/src/delegations" "${pkgs}/operations/src" \
    || fail "${code} no longer appears in the code that can emit it"
done

# fields.json declares exactly these values, plus "other".
schema() { jq -r --arg f "$1" '.services["tinycloud-mcp"].fields[$f].values[]' "${here}/fields.json"; }
all_codes="$(vrl_array stable_codes; vrl_array status_codes; vrl_array client_codes; vrl_array detail_codes; vrl_array approval_codes)"
same_set "fields.json tool" "$(vrl_array tools)"$'\n'"other" "$(schema tool)"
same_set "fields.json code" "${all_codes}"$'\n'"other" "$(schema code)"
same_set "fields.json stage" "$(vrl_array stages)"$'\n'"other" "$(schema stage)"
same_set "fields.json detail" "$(vrl_array details)"$'\n'"other" "$(schema detail)"
same_set "fields.json reason" "$(vrl_array connect_reasons; vrl_array delegation_reasons)"$'\n'"openkey_origin_changed"$'\n'"malformed_envelope"$'\n'"unexpected_label"$'\n'"partial"$'\n'"oversized"$'\n'"unclassified"$'\n'"other" "$(schema reason)"
# Every event the VRL emits is declared.
declared="$(jq -r '.services["tinycloud-mcp"].events[]' "${here}/fields.json")"
while IFS= read -r event; do
  grep -qx "${event}" <<<"${declared}" || fail "${event} is emitted but not declared in fields.json"
done < <(grep -o '"event": "mcp_[a-z_]*"' "${work}/vector.yaml" | sed 's/.*: "\(.*\)"/\1/' | sort -u)

# --- 3. the sidecar entrypoint, with stand-ins for vector and tail ---
sed -n '/^    command:$/,/^    logging:$/p' "${compose}" | sed '1,2d;$d' | sed 's/^        //; s/\$\$/$/g' >"${work}/entrypoint.sh"
[ -s "${work}/entrypoint.sh" ] || fail "no sidecar command found in the compose file"
sed -i "s|/var/lib/vector|${work}/lib|g" "${work}/entrypoint.sh"
mkdir -p "${work}/bin" "${work}/lib"
cat >"${work}/bin/vector" <<EOF
#!/bin/sh
printf '%s\n' "\$*" >"${work}/vector.called"
printf 'env=%s\n' "\${BETTERSTACK_SOURCE_TOKEN:-unset}" >>"${work}/vector.called"
EOF
cat >"${work}/bin/tail" <<EOF
#!/bin/sh
: >"${work}/idle.called"
EOF
chmod +x "${work}/bin/vector" "${work}/bin/tail"
run_entrypoint() { env -i PATH="${work}/bin:/usr/bin:/bin" BETTERSTACK_SOURCE_TOKEN="$1" /bin/sh -ec "$(cat "${work}/entrypoint.sh")" 2>"${work}/stderr"; }

run_entrypoint "" || fail "the sidecar entrypoint must exit cleanly when it idles without a token"
[ -e "${work}/idle.called" ] || fail "without a token the sidecar must idle"
[ ! -e "${work}/vector.called" ] || fail "without a token Vector must not start"
[ ! -e "${work}/lib/secrets/bs_token" ] || fail "without a token no token file may be written"
[ "$(cat "${work}/stderr")" = "log shipping disabled: no source token" ] || fail "the disabled status line changed"
rm -f "${work}/idle.called"

run_entrypoint "placeholder-token-value" || fail "the sidecar entrypoint failed with a token"
[ -e "${work}/vector.called" ] || fail "with a token Vector must start"
[ ! -e "${work}/idle.called" ] || fail "with a token the sidecar must not idle"
grep -q -- "--config ${work}/lib/vector.yaml" "${work}/vector.called" || fail "Vector did not start with the config file"
grep -qx 'env=unset' "${work}/vector.called" || fail "the token was still in Vector's environment"
[ "$(cat "${work}/lib/secrets/bs_token")" = "placeholder-token-value" ] || fail "the token file does not hold the token"
[ "$(stat -c %a "${work}/lib/secrets/bs_token")" = "600" ] || fail "the token file is not private"
[ -s "${work}/stderr" ] && fail "the sidecar wrote to stderr with a token"
true

# --- 1. validate and test the embedded config ---
# Run against a scratch data dir with a placeholder token; the secret backend reads that file at load.
printf 'placeholder' >"${work}/lib/secrets/bs_token"
sed -i "s|/var/lib/vector|${work}/lib|g" "${work}/vector.yaml"

if [ -n "${VECTOR_BIN:-}" ]; then
  vector() { "${VECTOR_BIN}" "$@"; }
else
  vector() { docker run --rm -v "${work}:${work}" -v "${here}:${here}:ro" --entrypoint vector "${image}" "$@"; }
fi

vector validate --no-environment "${work}/vector.yaml"
vector test "${work}/vector.yaml" "${here}/tests.yaml"
echo "all MCP log-shipper tests passed"
