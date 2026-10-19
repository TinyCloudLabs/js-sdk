# Agent Development Notes

This document gives coding agents enough local context to work in the TinyCloud JavaScript SDK
monorepo without guessing about repo boundaries, test expectations, or cross-repo API impact.

## Project Context

`TinyCloudLabs/js-sdk` contains the TypeScript SDK packages, WASM-backed SDK bindings, CLI, demos,
documentation, and integration tests used by TinyCloud applications.

Important areas:

- `packages/sdk-core`: shared SDK logic and service abstractions.
- `packages/sdk-services`: service-level APIs used across SDK surfaces.
- `packages/web-sdk`: browser-facing TinyCloud SDK.
- `packages/node-sdk`: Node/Bun-facing SDK used for server-side and integration test paths.
- `packages/sdk-rs`: Rust/WASM support packages for web and node targets.
- `packages/cli`: CLI package.
- `packages/replica`: durable read-only local KV replicas over `tinycloud.kv/sync` (engine,
  contracts, signed-grant parser, SQLite store). Keep it free of `@tinycloud/web-sdk` and
  `@tinycloud/node-sdk` imports; the browser worker build (TC-19) depends on that.
- `apps/*`: demos and examples, including OpenKey-related examples.
- `tests/node-sdk`: integration tests against a real TinyCloud Node server.

API compatibility is cross-repo. If SDK behavior changes request/response shapes, capability
construction, auth flows, feature detection, or client-visible errors, check whether TinyCloud Node
also needs a matching PR.

## Related Repositories

- `TinyCloudLabs/tinycloud-node`
  - Local path in the tinycloud-dev workspace: `repositories/tinycloud-node`.
  - Rust server that implements the protocol APIs this SDK calls.
  - SDK API/interface changes should normally be tested against the node path, and TinyCloud Node
    changes that affect clients should have a corresponding SDK PR.
- `TinyCloudLabs/openkey`
  - Local path in the tinycloud-dev workspace: `repositories/openkey`.
  - Authentication/product repo with OpenKey examples and TinyCloud/OpenKey integration concerns.
  - Check this repo when SDK changes affect OpenKey auth, sign-in, passkeys, OAuth, or identity
    integration flows.

## Build And Testing

Install dependencies with Bun from the repo root:

```bash
bun install
```

Common checks:

```bash
bun run build
bun run lint
bun run test
```

Package-focused commands:

```bash
bun --cwd packages/node-sdk run build
bun --cwd packages/web-sdk -c
bun --cwd packages/sdk-core -c
```

Run SDK node integration tests against a local TinyCloud Node:

```bash
cd ../tinycloud-node
TINYCLOUD_STORAGE__DATADIR="$(mktemp -d)/data" \
ROCKET_ADDRESS=127.0.0.1 \
ROCKET_PORT=9000 \
cargo run -p tinycloud-node --bin tinycloud
```

Then, from this repo:

```bash
cd tests/node-sdk
TC_TEST_SERVER=http://127.0.0.1:9000 bun test
```

For TinyCloud Node API/interface changes, write SDK tests against the node path. Web SDK coverage is
optional for some changes, but recommended when browser clients can reach the behavior.

Use changesets for package-facing changes that need release notes or version bumps:

```bash
bun changeset add
```

Changesets are `minor` (features) or `patch` (fixes), never `major`, even when a change breaks
compatibility; say what breaks in the changeset text. A major version is a human decision. A
maintainer approves one with an empty commit on the PR, and agents never write that commit or start
a release that would publish an unapproved major:

```bash
git commit --allow-empty -m "approve-major-release: @tinycloud/<package>"
```

The `Major release guard` check fails a PR that adds a `major` changeset or raises a major version
without that sign-off. The Release workflow applies the same rule before publishing betas and before
graduating them to stable (TC-615).

Release runs queue and never cancel each other. Each run pushes its version commit to `master` and
then publishes from that commit; if `master` moved first, the run fails without publishing and the
next run releases the changesets. Before publishing, it fails if npm's copy of any current version
was published before the commit that set that version (TC-1095). The fix is a new changeset for that
package, so the next run bumps past the stale version. A beta run also refuses to start while
`master` has stable versions npm lacks (a stable release that did not finish publishing). A
maintainer then re-dispatches the Stable Release, which publishes exactly those versions from their
release commit and graduates nothing else in that run.
npm can accept a publish and show it only much later (`@tinycloud/web-sdk`: 17 min to 2 h 25 min,
TC-1457). The beta publish step records the versions npm accepted as `tinycloud-npm-accepted:` lines in the
run's log. After the 30-minute budget, `Confirm npm has every current version` treats an accepted version
that is still not visible as a warning and a pending marker, not a failure. The next run's pre-publish
reads earlier Release runs' logs (read-only, `actions: read`) and stops, rather than publish the same
version number from newer code, when a version is missing from npm but an earlier run accepted it. It
names that run; wait until `npm view <name>@<version>` answers, then push to `master` again, or bump the
package with a changeset. A version no run accepted is published from HEAD as before.

Runbook: **`Confirm npm has every current version` warns "pending" for web-sdk → wait; never re-run;
never use the `release` dispatch (that's STABLE).** If it fails for web-sdk only, the version was not
recorded as accepted: check the publish step log and `npm view`, still never re-run or dispatch `release`.
A beta run's pre-publish check runs before it pushes, so a stop there leaves `master` and the pending
changesets untouched; push to `master` again once npm shows the version.

Stable-release installs use the committed lockfile before selecting a release and during recovery.
Only a newly versioned release may refresh it: an unfrozen recovery install can rewrite workspace
version metadata and make the immutable release checkout fail the clean-tree publishing guard.

## Debugging

- Confirm `TC_TEST_SERVER` points at the node instance you intend to test.
- Use a fresh TinyCloud Node data directory for integration tests when storage or auth state could
  affect results.
- Check the SDK client's host, prefix, DID, and space id before assuming the node is wrong.
- For delegation bugs, test both owner access and delegated access through the SDK path.
- Keep node logs, SDK test output, and browser/app logs separate so failures can be tied to one
  layer.
- Never print or commit real private keys, tokens, OAuth secrets, deploy keys, or production env
  values.

## Additional Context

- Keep changes narrow and package-local when possible.
- Public SDK behavior needs compatibility thinking: TinyCloud Node behavior, examples, docs, and
  package release notes should move together.
- API/interface changes should have a corresponding TinyCloud Node PR when the server contract must
  change.
- OpenKey-facing auth or identity changes should be checked against the OpenKey repo and examples.
- When agent-facing context changes, update this document's additional notes and append a concise
  entry to `agent.changelog.md` so future agents can see what changed and why.
- PR descriptions should list cross-repo dependencies, node/API implications, tests run, and any
  required changesets.
- Hosted personal apps live in `packages/operations/src/operations/apps.ts` and
  `src/tc-apps/`. The published skill is pinned under `src/tc-apps/vendor/`;
  update it with `bun scripts/sync-tc-apps-rules.ts`, then
  `bun run generate:operations-mcp`. Generation/checking is offline thereafter.
- Never add a response `deadlineMs` to personal-record writes: deadlines abandon
  work rather than cancel it. Preserve per-op outcomes after any committed write,
  including a partial move or failed derived-copy upkeep.
