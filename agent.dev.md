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
