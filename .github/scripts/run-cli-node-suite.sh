#!/usr/bin/env bash
# Runs one tests/cli suite against a throwaway tinycloud-node on loopback.
#
# Usage:  run-cli-node-suite.sh <node-binary> <test-file>
# Env:    RUNNER_TEMP   scratch root (required; the node data, the pid file and HOME live under it)
#
# The suite finds the node through TC_TEST_SERVER (tests/cli/setup.ts) and writes its CLI
# profile under HOME, so both point at this run's directories. Fails on a node that does
# not answer /version within 30 s, a failing or hanging suite (bun's per-test timeout plus
# the caller's step timeout), a skipped test, or a run with no passing test. The node is
# stopped on exit; its pid is also kept in $RUNNER_TEMP/cli-node-suites/*.pid so a later
# cleanup step can stop it if this script was killed.
set -euo pipefail

node_bin="${1:?usage: run-cli-node-suite.sh <node-binary> <test-file>}"
test_file="${2:?usage: run-cli-node-suite.sh <node-binary> <test-file>}"
: "${RUNNER_TEMP:?RUNNER_TEMP is not set}"
[ -x "$node_bin" ] || { echo "::error::node binary is not executable: $node_bin"; exit 1; }
[ -f "$test_file" ] || { echo "::error::test file does not exist: $test_file"; exit 1; }

root="$RUNNER_TEMP/cli-node-suites"
mkdir -p "$root"
run="$(mktemp -d "$root/run.XXXXXX")"
mkdir -p "$run/data" "$run/home" "$run/tmp"
port="$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
secret="$(head -c 48 /dev/urandom | base64 -w0 | tr '+/' '-_' | tr -d '=')"

(
  cd "$run"
  exec env \
    TMPDIR="$run/tmp" \
    TINYCLOUD_STORAGE__DATADIR="$run/data" \
    TINYCLOUD_ADDRESS=127.0.0.1 TINYCLOUD_PORT="$port" \
    ROCKET_ADDRESS=127.0.0.1 ROCKET_PORT="$port" \
    TINYCLOUD_KEYS__TYPE=Static TINYCLOUD_KEYS__SECRET="$secret" \
    "$node_bin" >"$run/node.log" 2>&1
) &
node_pid=$!
pidfile="$root/$(basename "$run").pid"
echo "$node_pid" >"$pidfile"

stop_node() {
  kill "$node_pid" 2>/dev/null || true
  wait "$node_pid" 2>/dev/null || true
  rm -f "$pidfile"
}
trap stop_node EXIT

server="http://127.0.0.1:$port"
ready=0
for _ in $(seq 1 30); do
  if ! kill -0 "$node_pid" 2>/dev/null; then
    echo "::error title=node::tinycloud-node exited before it was ready"
    cat "$run/node.log"
    exit 1
  fi
  if curl -sf "$server/version" >/dev/null; then ready=1; break; fi
  sleep 1
done
if [ "$ready" != 1 ]; then
  echo "::error title=node::tinycloud-node did not answer $server/version within 30 s"
  cat "$run/node.log"
  exit 1
fi
echo "node ready at $server (pid $node_pid)"

log="$run/suite.log"
set +e
HOME="$run/home" TMPDIR="$run/tmp" TC_HOME="$run/home" TC_TEST_SERVER="$server" \
  bun test "$test_file" --timeout 60000 2>&1 | tee "$log"
status=${PIPESTATUS[0]}
set -e
if [ "$status" != 0 ]; then
  echo "::error title=$test_file::suite failed (exit $status); node log follows"
  tail -n 50 "$run/node.log"
  exit "$status"
fi
if grep -Eq '^ *[1-9][0-9]* skip' "$log" || ! grep -Eq '^ *[1-9][0-9]* pass' "$log"; then
  echo "::error title=$test_file::tests were skipped or none passed"
  exit 1
fi
