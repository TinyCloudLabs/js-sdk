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
  An unpublished guidance checkpoint can be pinned with `--local-site SITE
  --source-commit SHA`; alpha inputs are recorded in `scripts/tc-apps-alpha-guidance.json`.
- Never add a response `deadlineMs` to personal-record writes: deadlines abandon
  work rather than cancel it. Preserve per-op outcomes after any committed write,
  including a partial move or failed derived-copy upkeep.
- Private history lives at `@tinycloud/operations/diagnostics`, independently of
  the lazy, framework-free operations root. Keep worker ESM/CJS assets published;
  diagnostics status/control must not load profiles, SDK/WASM, Commander or MCP.
  CLI diagnostics remain excluded in `packages/operations/coverage.json`, never
  shared business operations or public MCP tools/routes.
- Capture is default off. Scope only an explicitly selected tc-apps block;
  whole-client launch supplies attribution, never scope. Metadata is closed and
  content-free; selected detail requires independent owner selection and policy.
  Main business processes perform no diagnostic filesystem I/O. Preserve unknown
  outcomes, lost coverage, and separate business/protocol/delivery evidence.
  `telemetry.diagnostics` is independent of generic telemetry. Only recognized
  tc-apps invocations may opt in; a shared launch marker is not admission.
  A close deadline never authorizes bridge termination. Explicit native-child
  close/retirement replies do: some hosts keep the bridge alive after port.close().
- MCP inbound dispatch and transport sends stay synchronous, including cancellation
  during stdio policy refresh. Admission contexts are immutable across generation
  changes; racing requests may lack evidence, never gain permission to replay.
- Reject duplicate decoded JSON property names before importing raw bytes.
  Evidence identity is `source_id/event_id`; conflict-only imported assertions
  retain their original expiry. Do not renew retention or merge independent sources.
- Preserve global CLI option parsing before profile-free diagnostic controls:
  help/version and unknown options must never execute enable/delete actions.
  Resolve credential/app-state aliases only in isolated storage/control paths;
  the default app-state directory is protected even without `TC_APPS_STATE`.
  Retire cancelled MCP correlation without reassigning late responses, and keep
  verified callback evidence outside the service partition. Case expansion must
  retain source/event associations, not a cross-product of unrelated imports.
- After changing command inventory, run `bun run generate:operations-mcp` and
  `bun run --cwd packages/cli generate:reference`; verify CLI coverage, generated
  references/skills, boundaries and `bun run check:operations-mcp-pack` in isolated
  synthetic homes. Never use `tests/cli/setup.ts` with owner state. Packed fixture
  proof does not authorize publication, client installation or capture enablement.
  Native fault acceptance requires unprivileged Linux with `/proc` and `mkfifo`.
  Create private fixture ancestors explicitly; never weaken path validation to
  accommodate a group-writable directory inherited from the process umask.
- Release affected packages with minor/patch changesets and coordinated exact
  internal dependency pins; do not invent a next published version. Actual
  published-package/container worker checks, hosted isolated-volume encryption,
  backup/deletion and restart/rollback acceptance are separate authorized gates.
  Keep public logs/sysinfo disabled and preserve the single-replica assumption.
- The isolated npm alpha is built by `scripts/build-team-preview.mjs`, using
  ordinary bundled dependencies and a locked staging install. Keep build-only npm
  overrides out of the delivered manifest, and bundle SIWE's required ethers peer.
  `operations-mcp.yml` publishes only the verified tarball on the diagnostics
  feature branch with an explicit `[publish tc-apps alpha]` commit marker; its
  separate preview image consumes the same tarball. Never invoke production
  `mcp-image.yml` or normal release workflows for this alpha. Hosted access,
  encryption/backup policy and browser/phone acceptance are separate gates.
