#!/usr/bin/env bash
# Tests mcp-deployed-metadata.sh on fixtures: no network, no Phala account.
# Usage: test-mcp-deployed-metadata.sh   (from anywhere)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="${here}/mcp-deployed-metadata.sh"
root="$(mktemp -d -p "${TMPDIR:-/var/tmp}")"
trap 'rm -rf "${root}"' EXIT

HASH=$(printf 'a%.0s' {1..64})
NOT_OBSERVED="not_observed=running_image_digest,volume_lineage,state_secret_runtime,state_dir_runtime_perms,tenant_file_metadata"
# Values that must never reach the public log (stdout or stderr), wherever they sit in the Phala responses.
SENTINELS=(sentinel-image sentinel-container sentinel-name sentinel-env sentinel-error sentinel-compose sentinel-app)

fail() { echo "FAIL: $*" >&2; exit 1; }

no_sentinel() { # <name> <text>
  for s in "${SENTINELS[@]}"; do
    case "$2" in *"${s}"*) fail "$1: ${s} reached the output" ;; esac
  done
}

run() { # <cvm> <containers>  (file contents; "-" = empty file). Prints stdout; stderr must stay empty.
  local cvm="${root}/cvm.json" ps="${root}/ps.json"
  if [ "$1" = - ]; then : >"${cvm}"; else printf '%s' "$1" >"${cvm}"; fi
  if [ "$2" = - ]; then : >"${ps}"; else printf '%s' "$2" >"${ps}"; fi
  bash "${script}" "${cvm}" "${ps}" 2>"${root}/stderr"
  [ ! -s "${root}/stderr" ] || { no_sentinel "stderr" "$(cat "${root}/stderr")"; fail "stderr is not empty"; }
}

expect() { # <name> <expected-output> <actual-output>
  [ "$2" = "$3" ] || { printf 'FAIL: %s\n--- expected\n%s\n--- actual\n%s\n' "$1" "$2" "$3" >&2; exit 1; }
  no_sentinel "$1" "$3"
}

record() { # <cvm_record_available> <running> <in_progress> <public_logs> <public_sysinfo> <compose_hash> <containers_available>
  printf 'cvm_record_available=%s\ncvm_status_running=%s\ncvm_in_progress=%s\npublic_logs=%s\npublic_sysinfo=%s\ncompose_hash=%s\ncontainers_record_available=%s\n%s' \
    "$1" "$2" "$3" "$4" "$5" "$6" "$7" "${NOT_OBSERVED}"
}

CVM_RUNNING='{"status":"running","in_progress":false,"public_logs":false,"public_sysinfo":false,"compose_hash":"'"${HASH}"'","os":{"name":"dstack-0.5.12","is_dev":false,"os_image_hash":"'"${HASH}"'"},"app_id":"sentinel-app","name":"sentinel-name","encrypted_env":"sentinel-env","docker_compose_file":"sentinel-compose"}'
RUNNING="$(record true true false false false "${HASH}" false)"

# 1. The expected case under --no-public-sysinfo: the CVM is readable, Phala returns no container record.
expect "running CVM, no container record" "${RUNNING}" \
  "$(run "${CVM_RUNNING}" '{"containers":[],"error":"sentinel-error"}')"

# 2. Phala flags the container response offline.
expect "offline container response" "${RUNNING}" \
  "$(run "${CVM_RUNNING}" '{"is_online":false,"error":"sentinel-error","containers":[{"names":["/sentinel-container"],"image":"sentinel-image","image_id":"sentinel-image"}]}')"

# 3. A container record is returned: only its availability is reported. No hash, so the image cannot be confirmed
#    by guessing; malformed names/image/image_id values neither raise a jq error nor reach any output.
RECORDED="$(record true true false false false "${HASH}" true)"
flat="$(run "${CVM_RUNNING}" '{"containers":[{"names":["/sentinel-container"],"image":"sentinel-image:1","image_id":"sha256:sentinel-image","state":"running","status":"Up sentinel-error"}]}')"
expect "container record" "${RECORDED}" "${flat}"
expect "data envelope" "${RECORDED}" \
  "$(run "${CVM_RUNNING}" '{"success":true,"data":{"containers":[{"names":["/sentinel-container"],"image":"sentinel-image:1"}]}}')"
expect "another image gives the same output" "${flat}" \
  "$(run "${CVM_RUNNING}" '{"containers":[{"names":["/sentinel-container"],"image":"sentinel-image:2","image_id":"sha256:sentinel-name"}]}')"
expect "malformed names, image and image_id" "${RECORDED}" \
  "$(run "${CVM_RUNNING}" '{"containers":[{"names":"sentinel-name","image":{"ref":"sentinel-image"},"image_id":7},{"names":{"a":"sentinel-container"},"image":["sentinel-image"],"image_id":null},{"names":5}]}')"
expect "container entries that are not objects" "${RUNNING}" \
  "$(run "${CVM_RUNNING}" '{"containers":["sentinel-container",{"names":["sentinel-name"]}]}')"
expect "containers is not a list" "${RUNNING}" \
  "$(run "${CVM_RUNNING}" '{"containers":{"names":"sentinel-container","image":"sentinel-image"}}')"

# 4. Nothing readable: empty files, a non-JSON body and a Phala error object. Unavailable, never "down".
UNREADABLE="$(record false unknown unknown unknown unknown unknown false)"
expect "empty files" "${UNREADABLE}" "$(run - -)"
expect "non-JSON bodies" "${UNREADABLE}" "$(run 'sentinel-error: not json' 'sentinel-error')"
expect "error objects" "${UNREADABLE}" "$(run '{"error":"sentinel-error","http_status":401,"status":"error"}' '{"error":"sentinel-error"}')"
expect "wrong-shaped CVM record" "${UNREADABLE}" "$(run '{"status":{"state":"sentinel-error"},"os":"sentinel-name"}' '[1,2]')"
expect "a list instead of an object" "${UNREADABLE}" "$(run '["sentinel-error"]' '"sentinel-error"')"

# 5. Stopped, in-progress, public-logs and malformed fields print only booleans or unknown.
expect "stopped CVM with odd fields" "$(record true false true true unknown unknown false)" \
  "$(run '{"status":"stopped","in_progress":true,"public_logs":true,"public_sysinfo":"sentinel-env","compose_hash":"sentinel-compose\n::error::x","os":{"name":"sentinel-name"}}' '{"containers":"sentinel-container"}')"
expect "compose_hash that is not a bare 64-hex" "$(record true true unknown unknown unknown unknown false)" \
  "$(run '{"status":"running","compose_hash":{"sentinel-compose":1},"os":{}}' -)"

# 6. A jq failure ends in one fixed error line: no jq stderr, no partial record, a non-zero exit.
mkdir "${root}/stub"
printf '#!/bin/sh\necho "jq: error: Cannot index sentinel-error with sentinel-name" >&2\necho sentinel-env\nexit 5\n' >"${root}/stub/jq"
chmod +x "${root}/stub/jq"
printf '%s' "${CVM_RUNNING}" >"${root}/cvm.json"; printf '%s' '{"containers":[{"names":"sentinel-name"}]}' >"${root}/ps.json"
if out="$(PATH="${root}/stub:${PATH}" bash "${script}" "${root}/cvm.json" "${root}/ps.json" 2>&1)"; then
  fail "a jq failure did not fail the script"
fi
no_sentinel "jq failure" "${out}"
[ "${out}" = "::error::The CVM record could not be summarized" ] || fail "jq failure printed more than the fixed error: ${out}"

# 7. The allowlist refuses an unlisted field and an incomplete record, without printing them.
for bad in "sentinel-error=true" "$(printf '%s\ncompose_hash=sentinel-compose' "${RUNNING%%$'\n'compose_hash*}")"; do
  if out="$(bash -c 'source "$1"; check_record' _ "${script}" <<<"${bad}" 2>&1)"; then
    fail "check_record accepted a bad record"
  fi
  no_sentinel "check_record" "${out}"
done
if out="$(bash -c 'source "$1"; check_record' _ "${script}" <<<"${RUNNING/cvm_in_progress=false/cvm_in_progress=sentinel-env}" 2>&1)"; then
  fail "check_record accepted a non-boolean value"
fi
no_sentinel "check_record value" "${out}"
bash -c 'source "$1"; check_record' _ "${script}" <<<"${RUNNING}" >/dev/null || fail "check_record refused a valid record"

echo "all mcp-deployed-metadata tests passed"
