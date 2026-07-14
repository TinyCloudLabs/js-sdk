# TC-191 I0 Gate

Result: `unpublishable-defer`

The exact MCP v2 candidate verified by `tests/mcp-sdk-contract` is
`@modelcontextprotocol/server@2.0.0-beta.4` with the matching
`@modelcontextprotocol/client@2.0.0-beta.4`. Both packed manifests require
Node `>=20`. The contract passes the Zod 3 -> `zod-to-json-schema@3.25.1`
(`jsonSchema7`, `$refStrategy: "none"`) -> `fromJsonSchema` path, official
stdio client, structured output, protocol-only stdout, and packed-engine
checks. The fixture was executed with Node `20.19.4`, and package metadata is
packed from the installed candidates without registry access. Because the
candidate is beta, MCP publication is deferred; no beta package is published
or approved by this increment.

SDK prerequisite audit:

- Pass: `isCapabilitySubset` is exported from the public `sdk-core` and
  `node-sdk` indexes.
- Pass: `TinyCloudNode.getEncryptionNetworkIdForSpace` exists and the CLI
  hermetic fake-node boundary exercises its space-specific result.
- Blocker for I2: no public node-sdk helper binds a CID to a validated
  `PortableDelegation`; `computeDelegationCid` hashes authorization bytes but
  is not that binding contract.
- Blocker for I2: the repository has no hermetic local encrypted-node fixture
  proving runtime delegation activation and delegation-chain validation. The
  I0 tests do not claim cryptographic acceptance from mocked activation.

Named test boundaries:

- Node: `packages/cli/src/commands/secrets.test.ts` uses a narrow fake node for
  KV, encryption, permission, absence, and transport outcomes. Real SDK
  cryptographic import/activation remains outside this I0 fake boundary.
- Storage: `packages/cli/src/lib/permissions.test.ts` runs shipped writers in
  a child Bun process with an isolated `HOME` and snapshots exact
  `session.json`, `additional-delegations.json`, and `auth-requests.json`
  bytes.
- Clock/IDs: fixtures use fixed future expiries and fixed artifact timestamps;
  shipped request IDs and writer timestamps still use the current wall clock.
  Retention and injected-clock behavior remain deferred to I1.

Focused verification:

```text
bun test packages/cli/src/commands/secrets.test.ts   # 22 pass
bun test packages/cli/src/commands/auth.test.ts      # 18 pass
bun test packages/cli/src/lib/permissions.test.ts    # 5 pass
bun test packages/cli/src/output/errors.test.ts      # 3 pass
bun test tests/mcp-sdk-contract/contract.test.ts     # 4 pass
bun test tests/mcp-sdk-contract/prerequisites.test.ts # 1 pass
```

`packages/operations` and `packages/mcp` are intentionally not created in I0.
