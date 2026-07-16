# TC-191 I0 Gate

Result: `unpublishable-defer`

The exact MCP v2 candidate verified by `tests/mcp-sdk-contract` is
`@modelcontextprotocol/server@2.0.0-beta.4` with the matching
`@modelcontextprotocol/client@2.0.0-beta.4`. Both packed manifests require
Node `>=20`. The contract passes the Zod 3 -> `zod-to-json-schema@3.25.1`
(`jsonSchema7`, `$refStrategy: "none"`) -> `fromJsonSchema` path, official
stdio client, structured output, protocol-only stdout, and packed-engine
checks. The MCP stdio child reports its own runtime major and the contract
requires it to be Node `20`; `NODE_BINARY` remains an explicit local/CI
override. Package metadata is packed from the installed candidates without
registry access. Because the candidate is beta, MCP publication is deferred:
`unpublishable-defer` prohibits I4 MCP package publication, and no beta
package is published or approved by this increment.

The current I0/I2 published runtime boundary is the seven-package graph of
Bootstrap, SDK Services, SDK Core, Node WASM, Node SDK, Operations, and CLI.
Each packed manifest declares `engines.node: ">=20"`, and the graph is
exercised under exact Node `20.19.4` for both CommonJS and ESM entrypoints.

CI enforcement lives in `.github/workflows/tc-191-i0-gate.yml`. It pins Node
`20.19.4` and the repository-declared Bun `1.2.0`, installs only with
`bun install --frozen-lockfile`, builds the local workspace entrypoints and the
operations package needed by the CLI suites, then runs the seven focused suites
below. The test step
sets npm offline and its registry to loopback, so the local `npm pack` engine
check cannot use the npm registry. The suites use fake/local boundaries; they do
not call OpenKey or public TinyCloud nodes.

## Canonical MCP import contract

- `PortableDelegation.host` is optional.
- A canonical MCP import requires `requestId`.
- `requestId` resolves a stored profile/host-bound request.
- When the imported delegation has no `host`, SDK activation uses the host from
  that stored request.

The optional `requestId` in the schema fixture is solely an optional-field
schema-translation case; it does not relax the canonical MCP import contract.

SDK prerequisite audit:

- Executable pass: TypeScript compiles `isCapabilitySubset` imports through
  `packages/sdk-core/src/index.ts` and `packages/node-sdk/src/index.ts`, the
  two source public entrypoints. This is a structural public-export contract,
  not an export-name heuristic.
- Runtime pass: the built `@tinycloud/sdk-core` and `@tinycloud/node-sdk`
  package exports execute `isCapabilitySubset`, and the built
  `TinyCloudNode` prototype derives a space-specific encryption network ID.
- Executable pass: that same type contract calls
  `TinyCloudNode.getEncryptionNetworkIdForSpace` through the node-sdk source
  public index. The hermetic CLI fake node exercises its space-specific result
  in `packages/cli/src/commands/secrets.test.ts`.
- Executable pass: `activateValidatedRuntimeDelegation` is exported from
  `packages/node-sdk/src/index.ts`. The helper validates the delegation,
  recomputes its CID from the authorization bytes, and installs only the
  validated runtime authority. `packages/node-sdk/src/TinyCloudNode.validatedDelegation.test.ts`
  covers the public export, real WASM CID binding, altered audience/CID/
  authorization rejection, and idempotent activation.
- Executable pass: the hermetic encrypted-node fixture in
  `packages/node-sdk/src/test-support/hermetic-encrypted-node.ts` exercises
  restored-session signing, validated activation, and a narrow encrypted KV
  read/decrypt path without OpenKey, a public TinyCloud node, or a
  `TC_TEST_SERVER` dependency. The restore and validated-delegation security
  suites pass with 25 tests. These I2 prerequisites are closed; the remaining
  `unpublishable-defer` result is solely the separately documented MCP beta
  publication decision.

Named test boundaries:

- Node: `packages/cli/src/commands/secrets.test.ts` uses a narrow fake node for
  KV, encryption, permission, absence, and transport outcomes. Real SDK
  cryptographic import/activation remains outside this I0 fake boundary and is
  covered by the 25-test node-sdk restore/validated-delegation suites above.
- Storage: `packages/cli/src/lib/permissions.test.ts` runs shipped writers in
  a child Bun process with an isolated `HOME` and snapshots exact
  `session.json`, `additional-delegations.json`, and `auth-requests.json`
  bytes.
- Clock/IDs: fixtures use fixed future expiries and fixed artifact timestamps;
  shipped request IDs and writer timestamps still use the current wall clock.
  Retention and injected-clock behavior remain deferred to I1.

Focused verification:

```text
bun test packages/cli/src/commands/secrets.test.ts   # 26 pass
bun test packages/cli/src/commands/secrets-owner-retry.test.ts # 1 pass
bun test packages/cli/src/commands/auth.test.ts      # 32 pass
bun test packages/cli/src/lib/permissions.test.ts    # 8 pass
bun test packages/cli/src/output/errors.test.ts      # 4 pass
bun test tests/mcp-sdk-contract/contract.test.ts     # 4 pass
bun test tests/mcp-sdk-contract/prerequisites.test.ts # 2 pass
```

The packed public API check and the packed CJS/ESM SDK probes also pass under
the pinned Node `20.19.4` and Bun `1.2.0` gate runtimes.

The raw stdio protocol check has a 10-second local-process deadline only to
allow CI process scheduling; it has no network retry or external dependency.

`packages/mcp` is intentionally not created in I0. The I1 operations package is
built in this gate because I1 CLI suites import its published `./state` entrypoint.
