#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/artifact-lib.sh"

ensure_bun
ensure_feed_deps "$ROOT"

(cd "$ROOT/submodules/feed" && bun run typecheck)
(cd "$ROOT/submodules/feed" && bun run build)
