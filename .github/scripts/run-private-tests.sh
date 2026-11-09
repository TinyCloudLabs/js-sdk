#!/usr/bin/env bash
set -euo pipefail

# Give every test process a disposable fallback home before Bun imports tests.
# Normal CLI/build/release invocations do not use this test-only launcher.
home="$(mktemp -d "${TMPDIR:-/tmp}/tinycloud-bun-tests.XXXXXX")"
trap 'status=$?; rm -rf -- "$home"; exit "$status"' EXIT
export HOME="$home" TC_HOME="$home" USERPROFILE="$home"

"$@"
