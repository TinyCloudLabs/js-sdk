#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/artifact-lib.sh"

ensure_bun
ensure_feed_deps "$ROOT"

if [ -z "${AGENT_API_TOKEN:-}" ] && [ -z "${VITE_AGENT_TOKEN:-}" ]; then
  if command -v openssl >/dev/null 2>&1; then
    token="$(openssl rand -hex 16)"
  else
    token="local-$(date +%s)"
  fi
  export AGENT_API_TOKEN="$token"
  export VITE_AGENT_TOKEN="$token"
elif [ -z "${AGENT_API_TOKEN:-}" ]; then
  export AGENT_API_TOKEN="$VITE_AGENT_TOKEN"
elif [ -z "${VITE_AGENT_TOKEN:-}" ]; then
  export VITE_AGENT_TOKEN="$AGENT_API_TOKEN"
fi

export AGENT_ALLOWED_ORIGIN="${AGENT_ALLOWED_ORIGIN:-http://localhost:5173}"
export VITE_AGENT_HOST="${VITE_AGENT_HOST:-http://localhost:4097}"

"$ROOT/scripts/artifact-distillery-backend.sh" &
backend_pid=$!

cleanup() {
  kill "$backend_pid" >/dev/null 2>&1 || true
  wait "$backend_pid" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

sleep 2
exec "$ROOT/scripts/artifact-feed-dev.sh"
