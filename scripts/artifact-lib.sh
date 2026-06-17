#!/usr/bin/env bash

artifact_root() {
  cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd
}

ensure_bun() {
  if ! command -v bun >/dev/null 2>&1; then
    echo "bun is required. Install it from https://bun.sh and retry." >&2
    exit 1
  fi
}

ensure_feed_submodule() {
  local root="$1"
  if [ ! -f "$root/submodules/feed/package.json" ]; then
    git -C "$root" submodule update --init --recursive submodules/feed
  fi
}

ensure_feed_deps() {
  local root="$1"
  ensure_feed_submodule "$root"
  if [ ! -d "$root/submodules/feed/node_modules" ]; then
    (cd "$root/submodules/feed" && bun install)
  fi
}

resolve_distillery_repo() {
  local root="$1"
  local candidates=()

  if [ -n "${DISTILLERY_REPO:-}" ]; then
    candidates+=("$DISTILLERY_REPO")
  fi

  candidates+=(
    "$root/apps/distillery"
    "$root/../../distillery/docs/overview-live"
    "$root/../../distillery/feat/artifact-pipeline"
    "$root/../../distillery/feat/runs-endpoint"
    "$root/../../../repositories/distillery"
    "$root/../distillery"
  )

  local candidate
  for candidate in "${candidates[@]}"; do
    if [ -f "$candidate/harness/agent/src/server.ts" ]; then
      (cd "$candidate" && pwd)
      return 0
    fi
  done

  return 1
}

print_distillery_missing() {
  cat >&2 <<'EOF'
Could not find a distillery checkout with harness/agent/src/server.ts.

Set DISTILLERY_REPO to a distillery checkout that contains the agent backend, for example:

  DISTILLERY_REPO=/path/to/distillery bun run artifact:backend

In the Conductor workspace this is usually:

  DISTILLERY_REPO=../../distillery/docs/overview-live bun run artifact:backend
EOF
}
