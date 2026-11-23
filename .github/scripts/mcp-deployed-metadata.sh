#!/usr/bin/env bash
# Public-safe record of the deployed hosted MCP CVM: booleans and the Phala compose hash only.
#
# Usage:  mcp-deployed-metadata.sh <cvm.json> <containers.json>
#   <cvm.json>         output of `phala cvms get tinycloud-mcp --json`
#   <containers.json>  output of `phala ps tinycloud-mcp --json`
#
# `false` or `unknown` on a *_record_available / unknown field means the record could not be read or did not have
# the expected shape (empty, not JSON, an error object, offline). It never says the CVM is down.
#
# The run log of this repository is public. The record is built in memory, must hold exactly the fixed field set
# and every line must match the allowlist below; only then is it printed, all at once. Any other outcome is one
# fixed error line: no jq stderr, no partial record, no Phala text. Container fields are only type-checked, never
# printed or hashed (a hash of the image would let a reader confirm a guessed image reference).
set -euo pipefail

allow='^((cvm_record_available|cvm_status_running|cvm_in_progress|public_logs|public_sysinfo|containers_record_available)=(true|false|unknown)|compose_hash=([0-9a-f]{64}|unknown)|not_observed=[a-z_,]+)$'
fields='cvm_record_available cvm_status_running cvm_in_progress public_logs public_sysinfo compose_hash containers_record_available not_observed '
not_observed='running_image_digest,volume_lineage,state_secret_runtime,state_dir_runtime_perms,tenant_file_metadata'

fail() { echo "::error::$1"; exit 1; }

# Reads a record on stdin; prints it only if it is the complete fixed field set within the allowlist.
check_record() {
  local record line keys
  record=$(cat)
  keys=$(cut -d= -f1 <<<"${record}" | tr '\n' ' ')
  [ "${keys}" = "${fields}" ] || fail "The metadata record is incomplete"
  while IFS= read -r line; do
    [[ ${line} =~ ${allow} ]] || fail "A metadata field was refused by the public allowlist"
  done <<<"${record}"
  printf '%s\n' "${record}"
}

json_or_null() {
  if [ -s "$1" ] && jq -e . "$1" >/dev/null 2>&1; then cat "$1"; else echo null; fi
}

main() {
  local cvm_file=${1:?usage: mcp-deployed-metadata.sh <cvm.json> <containers.json>}
  local ps_file=${2:?usage: mcp-deployed-metadata.sh <cvm.json> <containers.json>}
  local cvm containers cvm_lines containers_available

  cvm=$(json_or_null "${cvm_file}")
  containers=$(json_or_null "${ps_file}")

  # Types are checked before use, so these programs cannot raise; stderr is dropped regardless.
  cvm_lines=$(jq -r '
    def flag(v): if (v | type) == "boolean" then (v | tostring) else "unknown" end;
    (if type == "object" then . else {} end) as $o
    | ($o.status // $o.cvm_status) as $s
    | (($s | type) == "string" and ($o | has("error") | not) and (($o.os | type) == "object")) as $available
    | "cvm_record_available=\($available)",
      "cvm_status_running=\(if $available then ($s == "running") else "unknown" end)",
      "cvm_in_progress=\(flag($o.in_progress))",
      "public_logs=\(flag($o.public_logs))",
      "public_sysinfo=\(flag($o.public_sysinfo))",
      "compose_hash=\(if ($o.compose_hash | type) == "string" and ($o.compose_hash | test("^[0-9a-f]{64}$")) then $o.compose_hash else "unknown" end)"
  ' <<<"${cvm}" 2>/dev/null) || fail "The CVM record could not be summarized"

  # Phala returns no container record while the CVM deploys with --no-public-sysinfo; that is reported, never inferred.
  containers_available=$(jq -r '
    (if type == "object" then (if (.data | type) == "object" then .data else . end) else {} end) as $d
    | if ($d.is_online != false) and (($d.containers | type) == "array") and (($d.containers | length) > 0)
        and ($d.containers | all(type == "object"))
      then "true" else "false" end
  ' <<<"${containers}" 2>/dev/null) || fail "The container record could not be summarized"

  check_record <<<"${cvm_lines}"$'\n'"containers_record_available=${containers_available}"$'\n'"not_observed=${not_observed}"
}

# Sourced by the test for check_record; only executed directly otherwise.
[[ ${BASH_SOURCE[0]} == "$0" ]] || return 0
main "$@"
