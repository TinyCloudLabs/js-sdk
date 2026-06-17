#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/artifact-lib.sh"

"$ROOT/scripts/artifact-feed-check.sh"
"$ROOT/scripts/artifact-backend-smoke.sh"

DISTILLERY="$(resolve_distillery_repo "$ROOT" || true)"
if [ -n "$DISTILLERY" ]; then
  (cd "$DISTILLERY" && bun test)
else
  print_distillery_missing
  exit 1
fi
