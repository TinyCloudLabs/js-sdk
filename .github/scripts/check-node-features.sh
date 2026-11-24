#!/usr/bin/env bash
# Starts a tinycloud-node binary on loopback and checks what /version reports, so a wrong or missing binary fails
# here instead of passing a real-node suite by accident (the binary has no --version flag).
#
# Usage:  check-node-features.sh <node-binary> <version> <feature> <present|absent>
#   <version>  the exact version the binary must report ("-" to skip the version check)
#   <feature>  a feature name that /version lists, e.g. encryption-named-keys-v1
# Env:    RUNNER_TEMP   scratch root (defaults to /tmp)
set -euo pipefail

bin="${1:?usage: check-node-features.sh <node-binary> <version> <feature> <present|absent>}"
want_version="${2:?version missing}"
feature="${3:?feature missing}"
expect="${4:?present|absent missing}"
case "$expect" in present|absent) ;; *) echo "::error::the last argument must be present or absent"; exit 2 ;; esac
[ -x "$bin" ] || { echo "::error::$bin is not executable"; exit 1; }

dir="$(mktemp -d "${RUNNER_TEMP:-/tmp}/node-features.XXXXXX")"
port="$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
secret="$(head -c 48 /dev/urandom | base64 -w0 | tr '+/' '-_' | tr -d '=')"
cd "$dir"
TINYCLOUD_STORAGE__DATADIR="$dir/data" \
  TINYCLOUD_ADDRESS=127.0.0.1 TINYCLOUD_PORT="$port" ROCKET_ADDRESS=127.0.0.1 ROCKET_PORT="$port" \
  TINYCLOUD_KEYS__TYPE=Static TINYCLOUD_KEYS__SECRET="$secret" \
  TINYCLOUD_ENCRYPTION_NETWORK__NAMED_KEYS_V1=true \
  TINYCLOUD_ENCRYPTION_NETWORK__DELETION_LEDGER_PATH="$dir/ledger" \
  "$bin" >"$dir/node.log" 2>&1 </dev/null &
pid=$!
trap 'kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; rm -rf "$dir"' EXIT

version=""
for _ in $(seq 1 30); do
  version="$(curl -sf "http://127.0.0.1:$port/version" || true)"
  [ -n "$version" ] && break
  kill -0 "$pid" 2>/dev/null || { echo "::error::the node exited early"; cat "$dir/node.log"; exit 1; }
  sleep 1
done
[ -n "$version" ] || { echo "::error::the node did not answer /version in 30 s"; cat "$dir/node.log"; exit 1; }
echo "$version"

if [ "$want_version" != "-" ] && [ "$(echo "$version" | jq -r .version)" != "$want_version" ]; then
  echo "::error::the node reports $(echo "$version" | jq -r .version), not $want_version"; exit 1
fi
listed=false
if echo "$version" | jq -e --arg feature "$feature" '.features | index($feature)' >/dev/null; then listed=true; fi
if [ "$expect" = present ] && [ "$listed" != true ]; then
  echo "::error::the node does not list $feature"; exit 1
fi
if [ "$expect" = absent ] && [ "$listed" = true ]; then
  echo "::error::the node lists $feature"; exit 1
fi
