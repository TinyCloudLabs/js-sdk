#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/artifact-lib.sh"

ensure_bun
git -C "$ROOT" submodule update --init --recursive submodules/feed
(cd "$ROOT/submodules/feed" && bun install)

echo "Inflated submodules/feed and installed feed dependencies."
