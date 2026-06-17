#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/artifact-lib.sh"

ensure_bun

port="${ARTIFACT_BACKEND_SMOKE_PORT:-4197}"
log="$(mktemp)"

AGENT_PORT="$port" \
AGENT_API_TOKEN="${AGENT_API_TOKEN:-local-artifact-smoke}" \
AGENT_ALLOWED_ORIGIN="${AGENT_ALLOWED_ORIGIN:-http://localhost:5173}" \
  "$ROOT/scripts/artifact-distillery-backend.sh" >"$log" 2>&1 &
pid=$!

cleanup() {
  kill "$pid" >/dev/null 2>&1 || true
  wait "$pid" >/dev/null 2>&1 || true
  rm -f "$log"
}
trap cleanup EXIT INT TERM

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS "http://127.0.0.1:$port/agent/info" >/dev/null 2>&1; then
    echo "Distillery backend smoke passed: http://127.0.0.1:$port/agent/info"
    exit 0
  fi
  if ! kill -0 "$pid" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

cat "$log" >&2
echo "Distillery backend smoke failed on port $port." >&2
exit 1
