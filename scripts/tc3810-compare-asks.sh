#!/usr/bin/env bash
# Compare the production request producers against master. Works from a working
# tree or on CI with the baseline ref available. Random per-request bytes need
# no normalization when the producing code and inputs to the build match.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
baseline="${1:-origin/master}"

check() {
  local flow="$1"
  shift
  git diff --exit-code "$baseline" -- "$@"
  printf '%s request sources are byte-identical to %s\n' "$flow" "$baseline"
}

check 'CLI login (paste, /a/ and device)' packages/cli/src packages/operations/src
check 'Web SDK sign-in and owner delegation (SIWE and OpenKey bridge)' \
  packages/web-sdk/src packages/node-sdk/src packages/sdk-rs
check 'Share invitation, link and grant creation' \
  packages/share-envelope/src packages/share-sdk/src \
  ':(exclude)packages/share-sdk/src/owner-root-cacao.ts' \
  ':(exclude)packages/share-sdk/src/share-root.ts'

# share-root.ts also verifies the signed response. The only edited line is in
# that verifier, after the request has already been sent.
root=packages/share-sdk/src/share-root.ts
diff -u <(git show "$baseline:$root") <(sed '/^  if (decoded\.delegationMode === "terminal") throw new ShareRootError("malformed-root", .* must allow delegation.*, wider);$/d' "$root")

# Pin the shared request-building code and build inputs too. The only exempt
# production modules are the two CACAO readers and their reader-only helper.
check 'Shared request code and build inputs' \
  bun.lock package.json packages/sdk-core packages/sdk-services \
  packages/bootstrap packages/share-sdk/package.json \
  ':(exclude)packages/sdk-core/src/delegations/cacao.ts' \
  ':(exclude)packages/sdk-core/src/delegations/recap-mode.ts' \
  ':(exclude)packages/sdk-core/src/delegations/recap-mode.test.ts'
