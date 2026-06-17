#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/artifact-lib.sh"

ensure_bun

DISTILLERY="$(resolve_distillery_repo "$ROOT" || true)"
if [ -z "$DISTILLERY" ]; then
  print_distillery_missing
  exit 1
fi

if [ ! -d "$DISTILLERY/node_modules" ]; then
  (cd "$DISTILLERY" && bun install)
fi

export DISTILLERY_REPO_ROOT="${DISTILLERY_REPO_ROOT:-$DISTILLERY}"
export AGENT_ALLOWED_ORIGIN="${AGENT_ALLOWED_ORIGIN:-http://localhost:5173}"

cd "$DISTILLERY"
exec bun harness/agent/src/server.ts "$@"
