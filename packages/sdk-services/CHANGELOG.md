# @tinycloudlabs/sdk-services

## 2.11.0-beta.11

### Patch Changes

- Updated dependencies [d894c57]
  - @tinycloud/bootstrap@2.7.0-beta.1

## 2.11.0-beta.10

### Minor Changes

- b38dd12: Add versioned OpenKey authorization protocol (v1) types and consumer wiring.
  - `sdk-core` exports `TinyCloudAuthorizationRequestV1`, `TinyCloudAuthorizationResultV1`, `CapabilityPresentationEnvelopeV1`, `validateAuthorizationResultV1`, `isPlausibleOpenKeyActionId`, `OPENKEY_ACTION_ID_SEPARATOR`.
  - `sdk-core` also exports narrowing-verification helpers `extractImmutableSiweFields`, `diffImmutableSiweFields`, `extractRecapAttenuations`, `unauthorizedRecapCapabilities` (with `ImmutableSiweFields` and `RecapAttenuation` types) so consumers can prove that a widget-signed SIWE is a strict narrowing of the SDK's original prepared SIWE.
  - `node-sdk` adds `NodeUserAuthorization.signInWithOpenKeyResult()` which completes the session with the exact `signedMessage` the OpenKey widget returned (not the caller's original prepared SIWE). Its `prepared` argument now REQUIRES `siwe` (the SDK-generated reference SIWE). Validates that the signature verifies against the returned bytes, that the recovered signer matches the local signer, that every immutable SIWE header field (domain, address, URI, version, chainId, nonce, issuedAt) is preserved byte-for-byte, that the ReCap capability set is a subset of the original request, and that `selectedActionKeys` are covered by that set. Note: `statement` handling was refined in `sol-final-continuation-fixes.md` — earlier drafts of this changeset incorrectly implied statement drift was always allowed; the delivered rule is that statement is byte-immutable for plain SIWEs and validated via the ReCap subset check for ReCap-bearing SIWEs.
  - `cli` browser-auth advertises `protocolVersion=1` on the /delegate URL, validates every callback payload before persisting (including structural checks on the optional `permissions[]` array), and (when the response includes effective `permissions`) refuses any grant that broadens the requested set.
  - `sdk-core.unauthorizedRecapCapabilities` now enforces EXACT MULTISET EQUALITY on the caveat list for every surviving (resource, ability) pair. Removing an entire ability or resource from the child is still permitted (that is genuine narrowing), but for any (resource, ability) that survives, the child's caveat list must equal the parent's caveat list as a multiset — i.e. same set of canonicalized caveat objects with the SAME duplicate counts. Concretely: (a) adding a caveat not present in the parent is rejected, (b) removing an alternative from a non-empty parent caveat list is rejected (removing all caveats to broaden from "restricted" to "unrestricted" is the special case of this), (c) replacing a caveat with a different one is rejected, (d) changing the number of times a duplicated caveat appears is rejected, and (e) the empty-parent case requires the child to also be empty on that ability (both sides carry zero caveats — neither imposes a restriction). Order within a caveat object's own keys is normalized via canonical JSON serialization before counting, so key reordering inside a single caveat is not itself a difference; only differences in the multiset of caveat objects matter.
  - `node-sdk.signInWithOpenKeyResult` now enforces stricter selectedActionKeys/permissions consistency: `selectedActionKeys` must cover every non-required capability in `signedMessage`; every returned `permissions` entry action must appear in `signedMessage`; broader `permissions` entries are rejected; empty `permissions[]` with a capability-bearing SIWE is rejected; duplicate `selectedActionKeys` entries are rejected; and the resource-substring fallback used to resolve permission entries has been replaced with a canonical two-form resolver (space or space+path) that fails on ambiguity.
  - `node-sdk` adds `NodeUserAuthorization.signInWithOpenKey(authorizeFn, opts)` — the production entry point that wires `prepareSessionForSigning` → OpenKey `authorizeTinyCloud()` → `signInWithOpenKeyResult` into one call. Callers provide a thin `authorizeFn` bridge to the OpenKey SDK; the node-sdk enforces every subset/immutable-field invariant before creating any session state.
  - `cli.parseDelegationExpiryField` numeric-seconds test fixture corrected (was passing `4_071_849_600` = Jan 11 2099, but expected Jan 1 2099 = `4_070_908_800`).
  - `node-sdk.signInWithOpenKeyResult` REJECTS legacy two-part `resource\0action` selectedActionKeys — Sol continuation contract requires the CANONICAL four-part `service\0space\0path\0ability` shape. The prior suffix-match fallback silently accepted IDs that did not carry a validated service namespace; four-part canonical IDs are the only accepted format.
  - `node-sdk` adds `wireOpenKeyAuthorize(openkey)` — a production adapter that translates any structurally-OpenKey object (typically `@openkey/sdk`'s `OpenKey` instance) into the `authorizeFn` callback `signInWithOpenKey` expects. The bridge does not fabricate protocol fields — every value flows through unchanged, and wire drift (missing `signedMessage`, unsupported `protocolVersion`, malformed selection) throws at the boundary. Enables real production consumers to wire OpenKey into `NodeUserAuthorization` without either package taking a direct build dependency on the other.

### Patch Changes

- cc75957: Sol continuation v2: add a production-shape narrowed-SIWE round-trip test
  to `NodeUserAuthorization.signInWithOpenKey.e2e.test.ts` that exercises
  the client's `signInWithOpenKeyResult` acceptance path against the exact
  wire shape the OpenKey `/authorize-sign` route emits when a user narrows
  capabilities in the widget. The test asserts:
  - The narrowed `signedMessage` decodes to the expected reduced ability
    set (kv/put removed, kv/get + capabilities/read retained).
  - The ReCap-derived statement in `signedMessage` no longer mentions the
    removed abilities.
  - The signature verifies against `signedMessage`.
  - Every canonical four-part `selectedActionKeys` entry resolves to a
    real (resource, ability) pair.
  - Every `permissions` entry has non-empty actions and matches a resource
    in the signed ReCap.

  This complements the matching OpenKey-side test in
  `apps/api/src/__tests__/delegate-authorize-sign-nodeauth-e2e.test.ts`
  which invokes the actual Hono router with the same production-shape
  SIWE. Together the two tests cover the wire boundary from both sides
  using real production code paths.

- e525137: Address Sol continuation-review rejection blockers on the OpenKey
  authorization consolidation.
  - `sdk-core.ImmutableSiweFields` now covers the full immutable header set:
    `expirationTime`, `notBefore`, `requestId`, `statement`, and
    `nonRecapResources`. `extractImmutableSiweFields` parses them and
    `diffImmutableSiweFields` includes them so a widget swapping any
    of these fields fails the SDK's byte-for-byte immutable check.
  - `sdk-core.unauthorizedRecapCapabilities` now enforces STRICT normalized
    caveat-multiset equality. Dropping alternatives from a disjunction,
    adding restrictions to an unrestricted parent, and any lexical caveat
    change all reject. Formal attenuation may relax this later.
  - `node-sdk.signInWithOpenKeyResult` requires the returned `permissions`
    array to equal the signed authority for EVERY resource/action pair,
    including structurally-required capabilities (e.g.
    `tinycloud.capabilities/read`). Missing entries and extras both fail
    hard (was: only non-required coverage was required).
  - `node-sdk.signInWithOpenKey` accepts an optional `openkeyKeyId` option
    and forwards it to the `authorizeFn` bridge so callers can pin the
    OpenKey key ID used by the widget.
  - `cli.auth request --grant` reports EFFECTIVE grants (from the signed
    delegation) rather than the originally-requested set — the previous
    behaviour over-reported authority when the user narrowed the request
    in the OpenKey UI. Applies to both OpenKey-backed and local-key flows.
  - `node-sdk` production TypeScript build no longer includes test sources
    or test-support modules, so `tsc --noEmit -p packages/node-sdk/tsconfig.json`
    now exits 0.
  - `node-sdk.signInWithOpenKey` resolves the actual TinyCloud activation host
    before preparing or sending the OpenKey authorization request. A per-call
    host override is installed as the session host, so the host bound into the
    OpenKey context and the host later used for activation cannot diverge.

- ba9c983: Merge-readiness consolidation for the OpenKey authorization protocol.

  The manifest digest now uses a shared sorted-key canonical JSON protocol with
  OpenKey, so whitespace and object-key order in a published well-known manifest
  do not break origin binding. The mandatory cross-repository CI job is pinned to
  the immutable compatible OpenKey revision containing the real Hono harness.

  `sdk-core` (`packages/sdk-core/src/authorization/openkey-protocol.ts`):
  - Extend `CapabilityPresentationEnvelopeV1` with an optional
    `manifests: Array<{ name?: string; appId?: string; payload?: Record<string, unknown> }>`
    field. Display-only. The receiving OpenKey side size-bounds and
    validates the envelope before use; envelopes carrying trust/verification
    override keys are dropped. Manifests never expand authority — the
    ReCap payload remains the sole gate.
  - Clarify in JSDoc that `reason` is caller-supplied context and
    rendered as "reason provided by caller" in the review UI unless a
    cryptographic manifest signature (or origin-bind) confirms it.

  `node-sdk` (`packages/node-sdk/src/authorization/NodeUserAuthorization.ts`):
  - `signInWithOpenKey` now builds a `CapabilityPresentationEnvelopeV1`
    from `this._manifest` (when set) and forwards it to the caller's
    `authorizeFn`. The envelope carries `displayName`, `reason`
    (optional), `manifestId`, a canonical SHA-256 `manifestDigest` over
    the primary manifest, and the full `manifests[]` payload array.
    Callers can pass a `reason` string in `options` — rendered as
    caller-supplied, never as verified.
  - New `options.reason?: string` parameter for
    `signInWithOpenKey(authorizeFn, options)`.
  - Internal helpers `canonicalStringify` + `canonicalSha256Hex` produce
    a stable digest that the OpenKey server can match against the
    fetched `.well-known/openkey-manifest.json` bytes. Apps that want
    origin-binding MUST publish the same JSON at the well-known path.
  - The presentation envelope is forwarded VERBATIM through the
    `OpenKeyBridgeInput` shape; the bridge does not fabricate any
    fields.

  `node-sdk` (`packages/node-sdk/src/authorization/openKeyBridge.ts`):
  - Extend `OpenKeyAuthorizeTinyCloud.authorizeTinyCloud()` request
    shape and `OpenKeyBridgeInput` with the optional `presentation`
    envelope. `wireOpenKeyAuthorize` forwards it to the underlying
    OpenKey SDK unchanged.

  CI (`.github/workflows/authority-tests.yml`):
  - The isolated `authority` job now sets `OPENKEY_HARNESS_OPTIONAL: "1"`
    so the cross-repo Hono contract test skips gracefully when no
    sibling OpenKey developer worktree is present. Callers can no
    longer break the js-sdk CI merely by not having OpenKey checked out
    alongside.
  - New required `cross-repo-contract` job checks out BOTH js-sdk and
    OpenKey (from `openkey-so/openkey@main`) at compatible revisions,
    builds js-sdk's authority packages, and runs the cross-repo Hono
    contract test with `OPENKEY_WORKTREE` and `OPENKEY_RUN_HARNESS=1`
    set. The dedicated job means the real Hono contract remains
    MANDATORY — the escape hatch in the isolated job only prevents
    incidental breakage.

  Cross-repo Hono test:
  - `NodeUserAuthorization.crossRepoHono.e2e.test.ts` now spawns the
    OpenKey harness with `OPENKEY_RUN_HARNESS=1` set in the child
    environment. The harness carries a defence-in-depth guard that
    refuses to boot without that variable, so this cross-repo contract
    test is the only path that spins it up (a broad `bun test` walk in
    the OpenKey repo, or an accidental double-spawn, cannot leak a
    stuck Hono process on the port).

  Documentation-only changeset for `@tinycloud/web-sdk` and
  `@tinycloud/sdk-services`; those packages export types re-exported
  from `sdk-core`, so the envelope shape change flows through
  transitively.

## 2.11.0-beta.8

### Patch Changes

- 68faad4: Reduce published SDK bundle and WASM artifact sizes by enabling safe package tree-shaking, using ES2020 output, removing release source maps, and optimizing WASM for size. `@tinycloud/sdk-services` keeps its published root entries in the `sideEffects` allowlist because they install debug globals at module scope.

  Measured by rebuilding the `origin/master` baseline (`9d4866f`) and this release tree in this worktree. Values are raw bytes / gzip level 9 bytes (`gzip -9 -c`):

  | Package entry                                                             |            Before |             After |
  | ------------------------------------------------------------------------- | ----------------: | ----------------: |
  | `@tinycloud/bootstrap` `capabilities.cjs`                                 |       6062 / 1408 |       6062 / 1408 |
  | `@tinycloud/bootstrap` `capabilities.js`                                  |        4834 / 964 |        4834 / 964 |
  | `@tinycloud/bootstrap` `generated/capabilities.cjs`                       |       7399 / 1546 |       7399 / 1546 |
  | `@tinycloud/bootstrap` `generated/capabilities.js`                        |       5971 / 1051 |       5971 / 1051 |
  | `@tinycloud/bootstrap` `index.cjs`                                        |      24918 / 5318 |      24918 / 5318 |
  | `@tinycloud/bootstrap` `index.js`                                         |      21996 / 4684 |      21996 / 4684 |
  | `@tinycloud/sdk-core` `bootstrap/index.cjs`                               |        1164 / 548 |        1164 / 548 |
  | `@tinycloud/sdk-core` `bootstrap/index.js`                                |          97 / 114 |          97 / 114 |
  | `@tinycloud/sdk-core` `delegations/index.cjs`                             |    310660 / 61313 |    309759 / 61082 |
  | `@tinycloud/sdk-core` `delegations/index.js`                              |    301141 / 59881 |    300220 / 59637 |
  | `@tinycloud/sdk-core` `index.cjs`                                         |   636247 / 125252 |   636247 / 125252 |
  | `@tinycloud/sdk-core` `index.js`                                          |   607698 / 121703 |   607698 / 121703 |
  | `@tinycloud/sdk-core` `policy/index.cjs`                                  |    109334 / 22646 |    109334 / 22646 |
  | `@tinycloud/sdk-core` `policy/index.js`                                   |    104481 / 21537 |    104481 / 21537 |
  | `@tinycloud/sdk-core` `requester/index.cjs`                               |    139251 / 29949 |    139251 / 29949 |
  | `@tinycloud/sdk-core` `requester/index.js`                                |    135505 / 29028 |    135505 / 29028 |
  | `@tinycloud/sdk-services` `encryption/index.cjs`                          |      44198 / 9624 |      44198 / 9624 |
  | `@tinycloud/sdk-services` `encryption/index.js`                           |      41192 / 8904 |      41192 / 8904 |
  | `@tinycloud/sdk-services` `index.cjs`                                     |    216891 / 41034 |    216891 / 41034 |
  | `@tinycloud/sdk-services` `index.js`                                      |    209330 / 39470 |    209330 / 39470 |
  | `@tinycloud/sdk-services` `internal/decrypt-transport-response-error.cjs` |        1540 / 681 |        1540 / 681 |
  | `@tinycloud/sdk-services` `internal/decrypt-transport-response-error.js`  |         419 / 268 |         419 / 268 |
  | `@tinycloud/sdk-services` `kv/index.cjs`                                  |     51068 / 10676 |     51068 / 10676 |
  | `@tinycloud/sdk-services` `kv/index.js`                                   |     49896 / 10259 |     49896 / 10259 |
  | `@tinycloud/sdk-services` `sql/index.cjs`                                 |      26895 / 6935 |      26895 / 6935 |
  | `@tinycloud/sdk-services` `sql/index.js`                                  |      25613 / 6530 |      25613 / 6530 |
  | `@tinycloud/web-sdk` `index.cjs`                                          | 3701304 / 1240268 | 3637285 / 1229488 |
  | `@tinycloud/web-sdk` `index.mjs`                                          | 3887911 / 1272304 | 3822218 / 1261105 |
  | `@tinycloud/web-sdk-wasm` `index.js`                                      |  1794903 / 695262 |  1752919 / 687800 |
  | `@tinycloud/node-sdk-wasm` `index.cjs`                                    |           61 / 91 |           61 / 91 |
  | `@tinycloud/node-sdk-wasm` `index.js`                                     |        1451 / 801 |        1451 / 801 |
  | `@tinycloud/node-sdk-wasm` `wasm/index.cjs`                               |     68817 / 10479 |     68817 / 10479 |
  | `@tinycloud/node-sdk-wasm` `wasm/tinycloud_web_sdk_rs_bg.wasm`            |  1322615 / 514215 |  1290495 / 512421 |

  The corrected `@tinycloud/web-sdk` dry-run pack contains 52 files and no `.map` files. `packages/web-sdk/tests/signInManifestRestore.test.ts` passed 8/8 with mocked auth under Bun. Live-wallet E2E was not run.

- Updated dependencies [68faad4]
  - @tinycloud/bootstrap@2.6.1-beta.0

## 2.11.0-beta.7

### Patch Changes

- 44ecf56: Release the exact-head session invocation APIs and canonical recipient-DID policy support used by Share.

## 2.11.0-beta.5

### Minor Changes

- f0842d8: TC-373: fix two blockers found in review of the batched account-bootstrap seed-spaces write.
  - `KVService.batchPut` now attaches structured metadata (`requestMayHaveDispatched`, and on the two unconfirmed-2xx response paths, `responseReceived` / `status` / `outcome: "batch-unconfirmed"`) to `NETWORK_ERROR`/`TIMEOUT` failures instead of leaving them unclassified. No new `ErrorCodes` member is added — the ambiguity is carried entirely in `meta` to avoid widening the exported `ErrorCode` union.
  - `AccountService.spaces.registerBatch`'s internal ambiguous-failure classifier is now a strict allow-list (previously a deny-list that defaulted to "retry", so deterministic failures like 400/409/422, `INVALID_INPUT`, and 501/505 triggered five pointless per-space reconcile puts). `registerBatch` now returns `RegisterBatchSuccess` (`{ spaces, recoveredFromBatchError? }`) instead of a bare array, so a batch write that recovers via per-space reconciliation is visible on the success payload, not only via `console.warn`.
  - `TinyCloudNode.bootstrapStatus` gains an optional `warnings?: BootstrapWarning[]` field: bootstrap that completes via a recovered ambiguous write is now programmatically distinguishable from a clean run (both were previously `{ skipped: false }`).

  Both changes are additive; nothing published is broken.

## 2.10.0

### Minor Changes

- 28cc430: Add batch KV reads and memoize TinyCloud node descriptor lookups to reduce SDK round trips.

## 2.10.0-beta.0

### Minor Changes

- 28cc430: Add batch KV reads and memoize TinyCloud node descriptor lookups to reduce SDK round trips.

## 2.8.0

### Minor Changes

- 7ecd455: Add bounded, byte-safe TinyCloud KV CRUD operations to MCP, including metadata reads, tagged content writes, create/replace/upsert modes, optimistic concurrency with ETags, and conditional deletion.
- 7ecd455: Add exact-database delegated SQLite schema inspection, parser-approved bounded read queries, and explicitly acknowledged parameterized DML execution to the canonical operations and MCP surfaces. SQL requests now forward hard row and byte limits where applicable and encode BLOB parameters byte-exactly.

## 2.8.0-beta.0

### Minor Changes

- 7ecd455: Add bounded, byte-safe TinyCloud KV CRUD operations to MCP, including metadata reads, tagged content writes, create/replace/upsert modes, optimistic concurrency with ETags, and conditional deletion.
- 7ecd455: Add exact-database delegated SQLite schema inspection, parser-approved bounded read queries, and explicitly acknowledged parameterized DML execution to the canonical operations and MCP surfaces. SQL requests now forward hard row and byte limits where applicable and encode BLOB parameters byte-exactly.

## 2.7.0

### Minor Changes

- d6d5ef1: Restore persisted sessions with their original private Ed25519 signer. Verify the signed SIWE, ReCap, Cacao header/CID, address, chain, session DID, and expiry before installing authority; atomically replace the auth/core/service host context while retaining every live secondary signer. Retired service graphs abort outstanding work and cannot reuse old encryption authority. Browser restore now preserves spaces and policy expiry, and rejected restores leave persisted storage untouched.
- cd8c11f: Add an explicit-space classified secret-read API that preserves safe KV,
  envelope, decrypt, and payload failure phases without changing legacy secret
  reads.

### Patch Changes

- b982b90: Declare Node 20 or newer as the supported runtime floor for the complete published SDK and Operations graph, including the CLI and Node WASM bindings.
- Updated dependencies [940ff1d]
- Updated dependencies [f7a1d4f]
- Updated dependencies [b982b90]
  - @tinycloud/bootstrap@2.6.0

## 2.7.0-beta.4

### Minor Changes

- d6d5ef1: Restore persisted sessions with their original private Ed25519 signer. Verify the signed SIWE, ReCap, Cacao header/CID, address, chain, session DID, and expiry before installing authority; atomically replace the auth/core/service host context while retaining every live secondary signer. Retired service graphs abort outstanding work and cannot reuse old encryption authority. Browser restore now preserves spaces and policy expiry, and rejected restores leave persisted storage untouched.
- cd8c11f: Add an explicit-space classified secret-read API that preserves safe KV,
  envelope, decrypt, and payload failure phases without changing legacy secret
  reads.

### Patch Changes

- b982b90: Declare Node 20 or newer as the supported runtime floor for the complete published SDK and Operations graph, including the CLI and Node WASM bindings.
- Updated dependencies [940ff1d]
- Updated dependencies [b982b90]
  - @tinycloud/bootstrap@2.6.0-beta.1

## 2.7.0-beta.3

### Patch Changes

- Updated dependencies [f7a1d4f]
  - @tinycloud/bootstrap@2.6.0-beta.0

## 2.6.3

### Patch Changes

- 3841be4: Fix account bootstrap failing on fresh keys because `sqlForSpace()` dropped `invokeAny` (issue #300).

  `TinyCloudNode.sqlForSpace()` (and its `kvForSpace()` counterpart) cloned the
  active service context with only `{invoke, fetch, hosts, telemetry}`, silently
  omitting `invokeAny`. Account bootstrap routes through this path: the
  `account-index-schema` step calls `account.index.ensure()`, whose migration
  batch dedupes to multiple SQL actions (`tinycloud.sql/schema` +
  `tinycloud.sql/write`). A multi-action batch requires `context.invokeAny`, so
  with it undefined `SQLService.invokeSQLAny` threw
  "SQL operation requires multiple permissions ... does not support
  multi-resource invocations", and the first `signIn()` on a fresh key failed to
  provision the account index (the `secret-records-schema` step would have hit
  the identical failure). The "recovery" on a second `signIn()` was accidental
  and incomplete — the existence check could pass and skip the schema step,
  leaving accounts without the account index.

  Thread `invokeAny` from the primary service context (`this._serviceContext.invokeAny`)
  into the space-scoped context that `sqlForSpace()` and `kvForSpace()` build, so
  multi-action bootstrap migrations mint their authorization header correctly.

## 2.6.3-beta.0

### Patch Changes

- 3841be4: Fix account bootstrap failing on fresh keys because `sqlForSpace()` dropped `invokeAny` (issue #300).

  `TinyCloudNode.sqlForSpace()` (and its `kvForSpace()` counterpart) cloned the
  active service context with only `{invoke, fetch, hosts, telemetry}`, silently
  omitting `invokeAny`. Account bootstrap routes through this path: the
  `account-index-schema` step calls `account.index.ensure()`, whose migration
  batch dedupes to multiple SQL actions (`tinycloud.sql/schema` +
  `tinycloud.sql/write`). A multi-action batch requires `context.invokeAny`, so
  with it undefined `SQLService.invokeSQLAny` threw
  "SQL operation requires multiple permissions ... does not support
  multi-resource invocations", and the first `signIn()` on a fresh key failed to
  provision the account index (the `secret-records-schema` step would have hit
  the identical failure). The "recovery" on a second `signIn()` was accidental
  and incomplete — the existence check could pass and skip the schema step,
  leaving accounts without the account index.

  Thread `invokeAny` from the primary service context (`this._serviceContext.invokeAny`)
  into the space-scoped context that `sqlForSpace()` and `kvForSpace()` build, so
  multi-action bootstrap migrations mint their authorization header correctly.

## 2.6.2

### Patch Changes

- b4d1e45: TC-111 follow-up: primary-grant selection now returns the caller's scoped
  session so multi-space recaps mint resources against the correct target space.

  TC-111 registers the primary session's own recap as a synthetic
  `provenance: "primary"` runtime grant that wins invocation selection when it
  covers the requested op. The two invocation call sites then used
  `grant.session` — the stored primary `ServiceSession`, whose `spaceId` is the
  PRIMARY space. For scoped ops on OTHER spaces that a multi-space recap also
  covers (e.g. an account-registry write whose fallback session targets the
  `account` space), the invocation was minted against the primary space
  (`applications/kv/...` instead of `account/kv/...`) and the node rejected it
  (observed as 404/40x in prod).

  `selectInvocationSession` and `invokeAnyWithRuntimePermissions` now invoke with
  the caller's passed/fallback session — which shares the primary delegation but
  carries the correct target `spaceId` — whenever the winning grant is the
  primary one. Non-primary grants keep using `grant.session`. Ranking semantics in
  `findGrantForOperations` are unchanged. This fixes wrong-space invocations for
  account/secrets ops that were minted against the primary space.

## 2.6.2-beta.0

### Patch Changes

- b4d1e45: TC-111 follow-up: primary-grant selection now returns the caller's scoped
  session so multi-space recaps mint resources against the correct target space.

  TC-111 registers the primary session's own recap as a synthetic
  `provenance: "primary"` runtime grant that wins invocation selection when it
  covers the requested op. The two invocation call sites then used
  `grant.session` — the stored primary `ServiceSession`, whose `spaceId` is the
  PRIMARY space. For scoped ops on OTHER spaces that a multi-space recap also
  covers (e.g. an account-registry write whose fallback session targets the
  `account` space), the invocation was minted against the primary space
  (`applications/kv/...` instead of `account/kv/...`) and the node rejected it
  (observed as 404/40x in prod).

  `selectInvocationSession` and `invokeAnyWithRuntimePermissions` now invoke with
  the caller's passed/fallback session — which shares the primary delegation but
  carries the correct target `spaceId` — whenever the winning grant is the
  primary one. Non-primary grants keep using `grant.session`. Ranking semantics in
  `findGrantForOperations` are unchanged. This fixes wrong-space invocations for
  account/secrets ops that were minted against the primary space.

## 2.6.1

### Patch Changes

- bf31506: Stop emitting a doomed `tinycloud.space/list` invocation after manifest/recap
  sign-in (TC-110).

  `scheduleAccountRegistrySync()` unconditionally called
  `account.spaces.syncAccessible()`, which invokes `tinycloud.space/list` — a
  capability a manifest/recap session never holds — producing a benign but noisy
  `401 Unauthorized Action: …/space/ tinycloud.space/list` on every sign-in
  (visible in browser consoles).

  The sync now skips `syncAccessible()` when the current session's recap does not
  grant `tinycloud.space/list`, reusing the TC-111 `recapOperationsFromSession`
  primitive. Only sessions without a SIWE recap (session-only /
  restored-without-siwe) keep today's behavior — every wallet SIWE session in
  this stack carries a recap, and none of them grant `space/list`, so all of
  them skip.

  Behavior note: `syncAccessible()` on this path could only ever register
  capability-registry-derived **delegated** spaces (the owned-space listing 401
  was already swallowed by `SpaceService.list`). That sign-in-time delegated
  registration no longer happens; owned spaces are unaffected (bootstrap seeding
  - `spaces.register()`), and `account.spaces.list({ preferIndex: true })`
    self-heals via its own `syncAccessible()` fallback.

  Additionally, `withAccountRegistryRetry` no longer retries authorization
  verdicts (`Unauthorized Action` / 401): those are deterministic, not transient,
  so it warns once and stops instead of re-emitting the doomed request. Generic
  errors still get the full retry budget.

  Guard only — no registry-convergence writes and no sdk-core changes; the CLI
  (`tc account spaces sync`) still uses `syncAccessible()` for explicit discovery.

- Updated dependencies [cd2aeb1]
  - @tinycloud/bootstrap@2.5.1

## 2.6.1-beta.1

### Patch Changes

- Updated dependencies [cd2aeb1]
  - @tinycloud/bootstrap@2.5.1-beta.0

## 2.6.1-beta.0

### Patch Changes

- bf31506: Stop emitting a doomed `tinycloud.space/list` invocation after manifest/recap
  sign-in (TC-110).

  `scheduleAccountRegistrySync()` unconditionally called
  `account.spaces.syncAccessible()`, which invokes `tinycloud.space/list` — a
  capability a manifest/recap session never holds — producing a benign but noisy
  `401 Unauthorized Action: …/space/ tinycloud.space/list` on every sign-in
  (visible in browser consoles).

  The sync now skips `syncAccessible()` when the current session's recap does not
  grant `tinycloud.space/list`, reusing the TC-111 `recapOperationsFromSession`
  primitive. Only sessions without a SIWE recap (session-only /
  restored-without-siwe) keep today's behavior — every wallet SIWE session in
  this stack carries a recap, and none of them grant `space/list`, so all of
  them skip.

  Behavior note: `syncAccessible()` on this path could only ever register
  capability-registry-derived **delegated** spaces (the owned-space listing 401
  was already swallowed by `SpaceService.list`). That sign-in-time delegated
  registration no longer happens; owned spaces are unaffected (bootstrap seeding
  - `spaces.register()`), and `account.spaces.list({ preferIndex: true })`
    self-heals via its own `syncAccessible()` fallback.

  Additionally, `withAccountRegistryRetry` no longer retries authorization
  verdicts (`Unauthorized Action` / 401): those are deterministic, not transient,
  so it warns once and stops instead of re-emitting the doomed request. Generic
  errors still get the full retry budget.

  Guard only — no registry-convergence writes and no sdk-core changes; the CLI
  (`tc account spaces sync`) still uses `syncAccessible()` for explicit discovery.

## 2.6.0

### Minor Changes

- 2f31800: Consolidate hand-written capability URN lists into a single source of truth
  (`@tinycloud/bootstrap` `capabilities` module, TC-112). The registry is defined
  in tinycloud-node and vendored verbatim as
  `@tinycloud/bootstrap/src/generated/capabilities.ts`; the per-service constants
  (`KV`, `SQL`, `DUCKDB`, …), `CAPABILITY_REGISTRY`, `SQLAction`, `DuckDbAction`,
  the node-sdk default abilities and root-delegation grants, the bootstrap
  manifests, and the web-sdk permission-modal labels are all derived from it. A CI
  job diffs the vendored copy against the node registry at the pinned rev so the
  SDK can never silently drift from the enforcer.

  BREAKING (minor, pre-1.0): `SQLAction.INSERT`, `SQLAction.UPDATE`, and
  `SQLAction.DELETE` are removed — they were never dispatched by the SDK nor
  accepted by the node. `SQLAction.SELECT` is retained as a deprecated alias of
  `read`. `SQLAction.EXECUTE`/`EXPORT` and `DuckDbAction.DESCRIBE`/`EXECUTE` are
  retained as exported constants but are request-kind artifacts, not registry
  capabilities (the node routes them by request-body kind; wire alignment tracked
  in TC-114). All other action shapes are unchanged.

### Patch Changes

- ac48f85: Fix runtime permission selection so the primary session's own recap always
  out-ranks any other covering runtime grant (TC-111).

  Previously `selectInvocationSession`/`invokeAnyWithRuntimePermissions` picked the
  first covering grant in insertion order, so a broad — possibly broken —
  bootstrap or delegated grant could hijack an operation the primary session
  itself already authorized and 401. The primary session is now registered as a
  synthetic highest-trust (`provenance: "primary"`) runtime grant built from the
  raw SIWE recap (full owner-scoped space URIs, so owners can never be conflated),
  and grant selection filters covering grants then prefers the primary. Spaces the
  node skipped activating this sign-in are excluded from the synthetic grant so it
  can never out-rank a working grant. The synthetic primary grant is never exposed
  through `getRuntimePermissionDelegations`/`hasRuntimePermissions`.

- 3ad0635: Mint the ability the node actually dispatches for SQL/DuckDB
  `execute`/`export`/`describe` (TC-114).

  `SQLService.executeStatementOnDb`/`exportDb` and
  `DuckDbService.executeStatementOnDb`/`describeDb` were sending the literal method
  name as the invocation ability (`tinycloud.sql/execute`,
  `tinycloud.sql/export`, `tinycloud.duckdb/execute`, `tinycloud.duckdb/describe`).
  The node has no such capabilities — it routes these requests by request-body
  kind gated by read/write/admin — so under chain containment a narrowly-delegated
  session (read+write, no `sql/*`/`duckdb/*` wildcard) 401s on these calls. They
  worked previously only because real grants carry the service wildcard.

  Each method now mints the dispatchable ability grounded in the node's routing:
  `export`/`describe` are authorized as reads (`tinycloud.{sql,duckdb}/read`) and
  named-statement execution as a write (`tinycloud.{sql,duckdb}/write`, which the
  SQL parser accepts for both read-only and mutating statements). Public method
  signatures and the exported `SQLAction`/`DuckDbAction` request-kind constants are
  unchanged. Narrowly-delegated sessions with no service wildcard now get working
  `export`, `executeStatement`, and `describe`.

- e07823b: Bump the tinycloud-node WASM-build pin to the v1.4.5 release tag and re-vendor
  the capability registry artifact (TC-119 / TC-121).

  `packages/sdk-rs/Cargo.toml` now pins `tinycloud-sdk-rs`/`tinycloud-sdk-wasm` to
  `tag = "v1.4.5"` (was `v1.4.2`). v1.4.5 is the first release that both contains
  the TC-112 capability registry AND wires it into the live `/invoke`//`/delegate`
  chain-containment paths (TC-119: alias/implication-aware delegation and
  invocation models). Unlike the v1.4.2 pin — where the registry was decoupled and
  the compiled WASM was unaffected — the WASM compiled from this pin genuinely
  changes (the `tinycloud-auth` crate it links in gained the W1 UCAN revocation
  handling shipped across v1.4.3–v1.4.5), so the published `web-sdk-wasm`/
  `node-sdk-wasm` binaries move.

  The vendored `@tinycloud/bootstrap` registry
  (`src/generated/capabilities.ts`) is re-vendored byte-identical from
  tinycloud-node@v1.4.5; the registry CONTENT (`REGISTRY_SOURCE_SHA256`,
  `CAPABILITIES`, `ALIASES`, `IMPLICATIONS`) is unchanged — only the new
  TC-121 `REGISTRY_SOURCE_REPO`/`REGISTRY_SOURCE_GIT_SHA` header exports and their
  doc comments are added. The capabilities-sync CI now anchors its fetch-and-diff
  to the explicit release-tag commit (`ANCHOR_NODE_REV`) rather than the header
  sha (which, for a locally-generated artifact, names the generation parent and
  would fetch the wrong artifact).

- Updated dependencies [2f31800]
  - @tinycloud/bootstrap@2.5.0

## 2.6.0-beta.3

### Patch Changes

- e07823b: Bump the tinycloud-node WASM-build pin to the v1.4.5 release tag and re-vendor
  the capability registry artifact (TC-119 / TC-121).

  `packages/sdk-rs/Cargo.toml` now pins `tinycloud-sdk-rs`/`tinycloud-sdk-wasm` to
  `tag = "v1.4.5"` (was `v1.4.2`). v1.4.5 is the first release that both contains
  the TC-112 capability registry AND wires it into the live `/invoke`//`/delegate`
  chain-containment paths (TC-119: alias/implication-aware delegation and
  invocation models). Unlike the v1.4.2 pin — where the registry was decoupled and
  the compiled WASM was unaffected — the WASM compiled from this pin genuinely
  changes (the `tinycloud-auth` crate it links in gained the W1 UCAN revocation
  handling shipped across v1.4.3–v1.4.5), so the published `web-sdk-wasm`/
  `node-sdk-wasm` binaries move.

  The vendored `@tinycloud/bootstrap` registry
  (`src/generated/capabilities.ts`) is re-vendored byte-identical from
  tinycloud-node@v1.4.5; the registry CONTENT (`REGISTRY_SOURCE_SHA256`,
  `CAPABILITIES`, `ALIASES`, `IMPLICATIONS`) is unchanged — only the new
  TC-121 `REGISTRY_SOURCE_REPO`/`REGISTRY_SOURCE_GIT_SHA` header exports and their
  doc comments are added. The capabilities-sync CI now anchors its fetch-and-diff
  to the explicit release-tag commit (`ANCHOR_NODE_REV`) rather than the header
  sha (which, for a locally-generated artifact, names the generation parent and
  would fetch the wrong artifact).

## 2.6.0-beta.2

### Patch Changes

- 3ad0635: Mint the ability the node actually dispatches for SQL/DuckDB
  `execute`/`export`/`describe` (TC-114).

  `SQLService.executeStatementOnDb`/`exportDb` and
  `DuckDbService.executeStatementOnDb`/`describeDb` were sending the literal method
  name as the invocation ability (`tinycloud.sql/execute`,
  `tinycloud.sql/export`, `tinycloud.duckdb/execute`, `tinycloud.duckdb/describe`).
  The node has no such capabilities — it routes these requests by request-body
  kind gated by read/write/admin — so under chain containment a narrowly-delegated
  session (read+write, no `sql/*`/`duckdb/*` wildcard) 401s on these calls. They
  worked previously only because real grants carry the service wildcard.

  Each method now mints the dispatchable ability grounded in the node's routing:
  `export`/`describe` are authorized as reads (`tinycloud.{sql,duckdb}/read`) and
  named-statement execution as a write (`tinycloud.{sql,duckdb}/write`, which the
  SQL parser accepts for both read-only and mutating statements). Public method
  signatures and the exported `SQLAction`/`DuckDbAction` request-kind constants are
  unchanged. Narrowly-delegated sessions with no service wildcard now get working
  `export`, `executeStatement`, and `describe`.

## 2.6.0-beta.1

### Patch Changes

- ac48f85: Fix runtime permission selection so the primary session's own recap always
  out-ranks any other covering runtime grant (TC-111).

  Previously `selectInvocationSession`/`invokeAnyWithRuntimePermissions` picked the
  first covering grant in insertion order, so a broad — possibly broken —
  bootstrap or delegated grant could hijack an operation the primary session
  itself already authorized and 401. The primary session is now registered as a
  synthetic highest-trust (`provenance: "primary"`) runtime grant built from the
  raw SIWE recap (full owner-scoped space URIs, so owners can never be conflated),
  and grant selection filters covering grants then prefers the primary. Spaces the
  node skipped activating this sign-in are excluded from the synthetic grant so it
  can never out-rank a working grant. The synthetic primary grant is never exposed
  through `getRuntimePermissionDelegations`/`hasRuntimePermissions`.

## 2.6.0-beta.0

### Minor Changes

- 2f31800: Consolidate hand-written capability URN lists into a single source of truth
  (`@tinycloud/bootstrap` `capabilities` module, TC-112). The registry is defined
  in tinycloud-node and vendored verbatim as
  `@tinycloud/bootstrap/src/generated/capabilities.ts`; the per-service constants
  (`KV`, `SQL`, `DUCKDB`, …), `CAPABILITY_REGISTRY`, `SQLAction`, `DuckDbAction`,
  the node-sdk default abilities and root-delegation grants, the bootstrap
  manifests, and the web-sdk permission-modal labels are all derived from it. A CI
  job diffs the vendored copy against the node registry at the pinned rev so the
  SDK can never silently drift from the enforcer.

  BREAKING (minor, pre-1.0): `SQLAction.INSERT`, `SQLAction.UPDATE`, and
  `SQLAction.DELETE` are removed — they were never dispatched by the SDK nor
  accepted by the node. `SQLAction.SELECT` is retained as a deprecated alias of
  `read`. `SQLAction.EXECUTE`/`EXPORT` and `DuckDbAction.DESCRIBE`/`EXECUTE` are
  retained as exported constants but are request-kind artifacts, not registry
  capabilities (the node routes them by request-body kind; wire alignment tracked
  in TC-114). All other action shapes are unchanged.

### Patch Changes

- Updated dependencies [2f31800]
  - @tinycloud/bootstrap@2.5.0-beta.0

## 2.4.2

## 2.4.1

## 2.4.0

### Minor Changes

- eb44380: `ensureOwnedSpaceHosted` now consults the account spaces registry before hosting

  Previously `TinyCloudNode.ensureOwnedSpaceHosted(name)` always delegated to
  `hostOwnedSpace`, which unconditionally submits the host-SIWE delegation. Owners
  who already had the space hosted (e.g. a git-haiku owner re-running TinyCloud
  Secrets setup) were therefore prompted to "host" their `secrets` space on every
  run.

  `ensureOwnedSpaceHosted` now resolves the owned space id and first checks the
  account spaces registry: the fast SQLite index (`account.index.spaces.list()`)
  as a best-effort short-circuit, falling back to the canonical, recap-readable KV
  record `account/spaces/{space_id}` (`account.spaces.get`). If the space is
  already registered/hosted it returns the id WITHOUT submitting a host delegation
  (no redundant signature). Only when the space is absent — or the registry check
  fails in any way (e.g. a cold index reporting `no such table: spaces`) — does it
  fall through to `hostOwnedSpace`. After hosting it durably write-through
  registers the space so subsequent calls short-circuit on the registry.

  `hostOwnedSpace` (always-host) is unchanged for callers that explicitly want it.
  The KV path is used rather than `syncAccessible()` because a manifest/recap
  session can read `account/spaces/` under the recap but does not hold
  `tinycloud.space/list`.

- 27f97d8: Add a public `ensureOwnedSpaceHosted(name)` method to `TinyCloudNode` and `TinyCloudWeb` for hosting an owner's owned space (e.g. `"secrets"`) from a session created with a manifest / capabilityRequest.

  A full-authority sign-in auto-hosts the owner's `secrets` space, but a session created with a manifest / capabilityRequest does not. Such a session could hold valid `tinycloud.kv/*` capabilities for the owned `secrets` space yet still fail its first scoped `secrets.put(...)` with `404 Space not found`, because the space was never registered on the node. `ensureOwnedSpaceHosted(name)` resolves the name to the owner's owned-space URI and hosts it via the host-SIWE delegation flow (one signature, idempotent server-side), so subsequent scoped secret writes succeed.

- aa050d1: Resolve and rehydrate `tinycloudHosts` on restored sessions.

  A restored session never resolved its TinyCloud hosts: the restore path
  rehydrated the delegation/address/chainId but never set the hosts, and the
  hosts a session was created with weren't persisted. The first kv/secrets/
  space/encryption call on a restored session therefore threw "TinyCloud
  hosts have not been resolved. Call signIn() first." (notably when
  `signIn()` short-circuited to a restored session).

  Fix (three parts):
  - Persist the hosts: `PersistedSessionData` gains an optional
    `tinycloudHosts` field (back-compat — old persisted sessions still
    validate), and both sign-in save paths write the just-resolved hosts.
  - Rehydrate on restore: `TinyCloudNode.restoreSession` accepts the
    persisted `tinycloudHosts`, adopts them for the service context and the
    auth layer (`setRestoredTinyCloudSession`), and the web SDK threads the
    field through `restoreDataFromPersisted`.
  - Lazy fallback: sessions persisted before this field re-resolve their
    hosts lazily (registry → `node.tinycloud.xyz` fallback) on the first
    host-needing call, exactly like a fresh sign-in. Resolution failures
    surface rather than being masked.

  A restored session now targets the same node as the original sign-in, so
  apps no longer need to pass `tinycloudHosts` explicitly or call
  `clearPersistedSession()` before sign-in.

### Patch Changes

- 895804a: Include `tinycloud.sql/ddl` in the implicit account registry index permission and legacy default SQL grant so account registry writes can create their SQLite tables and indexes on first use. SQL execute and batch calls now sign DDL statements with `tinycloud.sql/ddl`, and mixed batches sign with every required SQL action instead of collapsing to write-only.
- 934534d: Auth/hosting developer experience for the delegate-asks-owner-to-host model.
  - **`tc space host-request <name> --emit <file>`** (delegate-only): emits a `tinycloud.host.request` artifact naming the space and its resolved owner DID so an agent can surface it to the owner, who then runs `tc space host <name>`. If the caller IS the root authority of the resolved space, it refuses (`ALREADY_ROOT_AUTHORITY`) and tells them to host directly — no request is emitted. The command is a pure local emit and never contacts the node.
  - **Identity-aware `SPACE_NOT_HOSTED`**: an unhosted-space write/read previously surfaced as an opaque `404 - Space not found`. The kv and sql commands now normalize **only** that exact condition (404 + "Space not found" body) to a `SPACE_NOT_HOSTED` error carrying an identity-aware `hint`. The branch key `is_root_authority(space, active session)` is computed locally from the profile address + space DID (no network): the owner is told to run `tc space host <name>`, a delegate is told they cannot host and to emit `tc space host-request <name> --emit`. A wrong db/table/path or permission error is left untouched. A `delegate-session` profile is never treated as the root authority even when its stored ownerDid is the space owner, so a delegate always gets the host-request hint. `KVService` get/head/delete now preserve the `Space not found` 404 body (previously collapsed to `KV_NOT_FOUND` before the body was read), so unhosted-space **reads** normalize too, while a genuine missing key still reports `KV_NOT_FOUND`.
  - **SDK `grantAuthRequest(authority, request, options?)`** (`@tinycloud/node-sdk`): takes a delegation request artifact and returns a grant artifact (`tinycloud.auth.delegation`) by signing through `delegateTo`, so the request→grant handshake is callable programmatically. `tc auth grant` is now a thin wrapper over it. Adds the `AuthRequestArtifact`, `AuthDelegationArtifact`, and `DelegationAuthority` types.

- bd8a60f: Remove the deprecated `SQLAction.DDL` export and the `tinycloud.sql/ddl` permission display path. SQL schema changes use `SQLAction.SCHEMA` and `tinycloud.sql/schema`.
- c94b81b: Fix `tc kv put`/`kv delete --space` and binary KV round-trips.
  - `tc kv put` and `tc kv delete` now accept `--space <name|uri>`, routing through
    the space-scoped KV (`kvForSpace`) like `get`/`list`/`head` already did. KV
    writes to a non-primary space (e.g. an `applications` space) are now possible
    from the CLI.
  - Binary KV values now round-trip byte-identically. `KVService.put` sends
    Blob/ArrayBuffer/typed-array/Buffer values as raw bytes
    (`application/octet-stream`, honoring an explicit `contentType`) instead of
    JSON-stringifying them into `{"type":"Buffer","data":[...]}`. A new
    `KVGetOptions.binary` returns the raw response bytes as a `Uint8Array`, and the
    CLI's `kv get -o <file>` / `--raw` use it so images and other binaries are
    written out unchanged.

- fa4a7c7: Add regression coverage for SQL migration batches that require both `tinycloud.sql/ddl` and `tinycloud.sql/write`, including the legacy-session runtime permission repair path used by TinyCloud Secrets.
- d4a0a69: Add a SQL migrations helper on database handles: `sql.db(name).migrations.apply({ namespace, migrations })`. The helper records applied migration ids in a TinyCloud-managed table, signs migration DDL/write/read actions through the SQL service, and returns whether migrations were applied or already current.

  The account registry index now uses the migrations helper for its schema setup, and SQL/DuckDB service errors sanitize non-JSON proxy HTML pages into concise retryable messages while preserving a bounded debug snippet in error metadata.

- a22a7f0: Rename the SDK-emitted SQL schema-change permission from `tinycloud.sql/ddl` to `tinycloud.sql/schema`, including manifest defaults and account-registry grants.

  TinyCloudWeb now treats a restored persisted session as stale when it does not cover the currently configured manifest permissions, then runs the normal manifest sign-in flow instead of letting apps request those manifest permissions separately after login.

- 42f1235: Add an opt-in TinyCloud debug logger controlled by `TinyCloud_debug`. The logger keeps a 1000-event in-memory ring buffer, writes structured events to `console.debug` when enabled, exposes browser console helpers for enabling, disabling, inspecting, and clearing logs, persists browser debug mode through `localStorage`, and captures service events plus `fetch`, `invoke`, and `invokeAny` timings.

## 2.4.0-beta.19

### Patch Changes

- 42f1235: Add an opt-in TinyCloud debug logger controlled by `TinyCloud_debug`. The logger keeps a 1000-event in-memory ring buffer, writes structured events to `console.debug` when enabled, exposes browser console helpers for enabling, disabling, inspecting, and clearing logs, persists browser debug mode through `localStorage`, and captures service events plus `fetch`, `invoke`, and `invokeAny` timings.

## 2.4.0-beta.16

### Minor Changes

- eb44380: `ensureOwnedSpaceHosted` now consults the account spaces registry before hosting

  Previously `TinyCloudNode.ensureOwnedSpaceHosted(name)` always delegated to
  `hostOwnedSpace`, which unconditionally submits the host-SIWE delegation. Owners
  who already had the space hosted (e.g. a git-haiku owner re-running TinyCloud
  Secrets setup) were therefore prompted to "host" their `secrets` space on every
  run.

  `ensureOwnedSpaceHosted` now resolves the owned space id and first checks the
  account spaces registry: the fast SQLite index (`account.index.spaces.list()`)
  as a best-effort short-circuit, falling back to the canonical, recap-readable KV
  record `account/spaces/{space_id}` (`account.spaces.get`). If the space is
  already registered/hosted it returns the id WITHOUT submitting a host delegation
  (no redundant signature). Only when the space is absent — or the registry check
  fails in any way (e.g. a cold index reporting `no such table: spaces`) — does it
  fall through to `hostOwnedSpace`. After hosting it durably write-through
  registers the space so subsequent calls short-circuit on the registry.

  `hostOwnedSpace` (always-host) is unchanged for callers that explicitly want it.
  The KV path is used rather than `syncAccessible()` because a manifest/recap
  session can read `account/spaces/` under the recap but does not hold
  `tinycloud.space/list`.

## 2.4.0-beta.15

### Patch Changes

- bd8a60f: Remove the deprecated `SQLAction.DDL` export and the `tinycloud.sql/ddl` permission display path. SQL schema changes use `SQLAction.SCHEMA` and `tinycloud.sql/schema`.

## 2.4.0-beta.14

### Patch Changes

- a22a7f0: Rename the SDK-emitted SQL schema-change permission from `tinycloud.sql/ddl` to `tinycloud.sql/schema`, including manifest defaults and account-registry grants.

  TinyCloudWeb now treats a restored persisted session as stale when it does not cover the currently configured manifest permissions, then runs the normal manifest sign-in flow instead of letting apps request those manifest permissions separately after login.

## 2.4.0-beta.12

### Patch Changes

- fa4a7c7: Add regression coverage for SQL migration batches that require both `tinycloud.sql/ddl` and `tinycloud.sql/write`, including the legacy-session runtime permission repair path used by TinyCloud Secrets.

## 2.4.0-beta.11

### Minor Changes

- aa050d1: Resolve and rehydrate `tinycloudHosts` on restored sessions.

  A restored session never resolved its TinyCloud hosts: the restore path
  rehydrated the delegation/address/chainId but never set the hosts, and the
  hosts a session was created with weren't persisted. The first kv/secrets/
  space/encryption call on a restored session therefore threw "TinyCloud
  hosts have not been resolved. Call signIn() first." (notably when
  `signIn()` short-circuited to a restored session).

  Fix (three parts):
  - Persist the hosts: `PersistedSessionData` gains an optional
    `tinycloudHosts` field (back-compat — old persisted sessions still
    validate), and both sign-in save paths write the just-resolved hosts.
  - Rehydrate on restore: `TinyCloudNode.restoreSession` accepts the
    persisted `tinycloudHosts`, adopts them for the service context and the
    auth layer (`setRestoredTinyCloudSession`), and the web SDK threads the
    field through `restoreDataFromPersisted`.
  - Lazy fallback: sessions persisted before this field re-resolve their
    hosts lazily (registry → `node.tinycloud.xyz` fallback) on the first
    host-needing call, exactly like a fresh sign-in. Resolution failures
    surface rather than being masked.

  A restored session now targets the same node as the original sign-in, so
  apps no longer need to pass `tinycloudHosts` explicitly or call
  `clearPersistedSession()` before sign-in.

## 2.4.0-beta.10

### Minor Changes

- 27f97d8: Add a public `ensureOwnedSpaceHosted(name)` method to `TinyCloudNode` and `TinyCloudWeb` for hosting an owner's owned space (e.g. `"secrets"`) from a session created with a manifest / capabilityRequest.

  A full-authority sign-in auto-hosts the owner's `secrets` space, but a session created with a manifest / capabilityRequest does not. Such a session could hold valid `tinycloud.kv/*` capabilities for the owned `secrets` space yet still fail its first scoped `secrets.put(...)` with `404 Space not found`, because the space was never registered on the node. `ensureOwnedSpaceHosted(name)` resolves the name to the owner's owned-space URI and hosts it via the host-SIWE delegation flow (one signature, idempotent server-side), so subsequent scoped secret writes succeed.

### Patch Changes

- d4a0a69: Add a SQL migrations helper on database handles: `sql.db(name).migrations.apply({ namespace, migrations })`. The helper records applied migration ids in a TinyCloud-managed table, signs migration DDL/write/read actions through the SQL service, and returns whether migrations were applied or already current.

  The account registry index now uses the migrations helper for its schema setup, and SQL/DuckDB service errors sanitize non-JSON proxy HTML pages into concise retryable messages while preserving a bounded debug snippet in error metadata.

## 2.4.0-beta.8

### Patch Changes

- 895804a: Include `tinycloud.sql/ddl` in the implicit account registry index permission and legacy default SQL grant so account registry writes can create their SQLite tables and indexes on first use. SQL execute and batch calls now sign DDL statements with `tinycloud.sql/ddl`, and mixed batches sign with every required SQL action instead of collapsing to write-only.

## 2.4.0-beta.2

### Patch Changes

- 934534d: Auth/hosting developer experience for the delegate-asks-owner-to-host model.
  - **`tc space host-request <name> --emit <file>`** (delegate-only): emits a `tinycloud.host.request` artifact naming the space and its resolved owner DID so an agent can surface it to the owner, who then runs `tc space host <name>`. If the caller IS the root authority of the resolved space, it refuses (`ALREADY_ROOT_AUTHORITY`) and tells them to host directly — no request is emitted. The command is a pure local emit and never contacts the node.
  - **Identity-aware `SPACE_NOT_HOSTED`**: an unhosted-space write/read previously surfaced as an opaque `404 - Space not found`. The kv and sql commands now normalize **only** that exact condition (404 + "Space not found" body) to a `SPACE_NOT_HOSTED` error carrying an identity-aware `hint`. The branch key `is_root_authority(space, active session)` is computed locally from the profile address + space DID (no network): the owner is told to run `tc space host <name>`, a delegate is told they cannot host and to emit `tc space host-request <name> --emit`. A wrong db/table/path or permission error is left untouched. A `delegate-session` profile is never treated as the root authority even when its stored ownerDid is the space owner, so a delegate always gets the host-request hint. `KVService` get/head/delete now preserve the `Space not found` 404 body (previously collapsed to `KV_NOT_FOUND` before the body was read), so unhosted-space **reads** normalize too, while a genuine missing key still reports `KV_NOT_FOUND`.
  - **SDK `grantAuthRequest(authority, request, options?)`** (`@tinycloud/node-sdk`): takes a delegation request artifact and returns a grant artifact (`tinycloud.auth.delegation`) by signing through `delegateTo`, so the request→grant handshake is callable programmatically. `tc auth grant` is now a thin wrapper over it. Adds the `AuthRequestArtifact`, `AuthDelegationArtifact`, and `DelegationAuthority` types.

## 2.4.0-beta.1

### Patch Changes

- c94b81b: Fix `tc kv put`/`kv delete --space` and binary KV round-trips.
  - `tc kv put` and `tc kv delete` now accept `--space <name|uri>`, routing through
    the space-scoped KV (`kvForSpace`) like `get`/`list`/`head` already did. KV
    writes to a non-primary space (e.g. an `applications` space) are now possible
    from the CLI.
  - Binary KV values now round-trip byte-identically. `KVService.put` sends
    Blob/ArrayBuffer/typed-array/Buffer values as raw bytes
    (`application/octet-stream`, honoring an explicit `contentType`) instead of
    JSON-stringifying them into `{"type":"Buffer","data":[...]}`. A new
    `KVGetOptions.binary` returns the raw response bytes as a `Uint8Array`, and the
    CLI's `kv get -o <file>` / `--raw` use it so images and other binaries are
    written out unchanged.

## 2.3.0

### Minor Changes

- fb96a1e: Rename owner/delegate identity surfaces from primary/principal terminology to owner terminology.

  CLI profiles and auth request artifacts now use `ownerDid` and `sessionDid`. Encryption network descriptors and discovery APIs now expose the owner identity as `ownerDid`.

- c7676d6: Add `kv.batchPut` for one-invocation TinyCloud KV batch writes.

### Patch Changes

- 9ee7404: Harden encryption-network decrypt flows, add CLI secrets coverage, and fix web WASM initialization.
- d606baf: Accept equivalent `did:pkh:eip155` owner DID address casing when validating encryption network descriptors, including legacy `principal` descriptors, so `tc secrets` can read existing network metadata. Pin the Rust WASM source to the released `tinycloud-node` `v1.4.2` tag.
- 945f43c: Sign SQLite PRAGMA statements with the SQL admin capability so approved admin grants are used for PRAGMA requests.
- f11e468: Add default-off telemetry configuration and named span timing events for SDK operations.

## 2.3.0-beta.8

### Patch Changes

- f11e468: Add default-off telemetry configuration and named span timing events for SDK operations.

## 2.3.0-beta.7

### Patch Changes

- 945f43c: Sign SQLite PRAGMA statements with the SQL admin capability so approved admin grants are used for PRAGMA requests.

## 2.3.0-beta.6

### Minor Changes

- c7676d6: Add `kv.batchPut` for one-invocation TinyCloud KV batch writes.

## 2.3.0-beta.5

### Patch Changes

- d606baf: Accept equivalent `did:pkh:eip155` owner DID address casing when validating encryption network descriptors, including legacy `principal` descriptors, so `tc secrets` can read existing network metadata. Pin the Rust WASM source to the released `tinycloud-node` `v1.4.2` tag.

## 2.3.0-beta.2

### Minor Changes

- fb96a1e: Rename owner/delegate identity surfaces from primary/principal terminology to owner terminology.

  CLI profiles and auth request artifacts now use `ownerDid` and `sessionDid`. Encryption network descriptors and discovery APIs now expose the owner identity as `ownerDid`.

## 2.2.1-beta.0

### Patch Changes

- 9ee7404: Harden encryption-network decrypt flows, add CLI secrets coverage, and fix web WASM initialization.

## 2.2.0

### Minor Changes

- 35212bb: Add canonical scoped secret support. Manifest `secrets` entries now accept object specs with `scope` and optional `name`, and `tc.secrets` supports scoped `get`, `put`, `delete`, and `list` calls using the canonical `secrets/scoped/<scope>/<NAME>` vault layout.
- 46f126a: Add manifest `secrets` declarations and SDK helpers backed by the secrets space vault, including read-default permissions and write/delete escalation.
- f43143d: TC-1372: add `kv.createSignedReadUrl()` for minting short-lived signed KV read URLs through tinycloud-node's `/signed/kv` endpoint.

  The method signs a normal `tinycloud.kv/get` invocation for the resolved key path, posts the signed URL request to tinycloud-node, and returns an absolute URL plus the opaque ticket id and expiry metadata. Requires tinycloud-node with the TC-1368 signed KV URL API.

  The default signed read URL expiry is defined in `sdk-core` as
  `EXPIRY.SIGNED_READ_URL_MS` and exposed as
  `DEFAULT_SIGNED_READ_URL_EXPIRY_MS`.

### Patch Changes

- 976b3c7: Deduplicate in-flight vault unlocks and reuse in-memory vault key material so repeated OpenKey-backed unlock paths do not trigger duplicate signer prompts.

## 2.2.0-beta.13

### Patch Changes

- 976b3c7: Deduplicate in-flight vault unlocks and reuse in-memory vault key material so repeated OpenKey-backed unlock paths do not trigger duplicate signer prompts.

## 2.2.0-beta.12

### Minor Changes

- f43143d: TC-1372: add `kv.createSignedReadUrl()` for minting short-lived signed KV read URLs through tinycloud-node's `/signed/kv` endpoint.

  The method signs a normal `tinycloud.kv/get` invocation for the resolved key path, posts the signed URL request to tinycloud-node, and returns an absolute URL plus the opaque ticket id and expiry metadata. Requires tinycloud-node with the TC-1368 signed KV URL API.

  The default signed read URL expiry is defined in `sdk-core` as
  `EXPIRY.SIGNED_READ_URL_MS` and exposed as
  `DEFAULT_SIGNED_READ_URL_EXPIRY_MS`.

## 2.2.0-beta.10

### Minor Changes

- 35212bb: Add canonical scoped secret support. Manifest `secrets` entries now accept object specs with `scope` and optional `name`, and `tc.secrets` supports scoped `get`, `put`, `delete`, and `list` calls using the canonical `secrets/scoped/<scope>/<NAME>` vault layout.

## 2.2.0-beta.7

### Minor Changes

- 46f126a: Add manifest `secrets` declarations and SDK helpers backed by the secrets space vault, including read-default permissions and write/delete escalation.

## 2.1.0

### Minor Changes

- 8abfb4e: Bump past stale `2.1.0-beta.0` / `1.7.2-beta.0` ghost versions to publish PR #184's capability-chain delegation code.

  The earlier `2.1.0-beta.0` (TS SDKs) and `1.7.2-beta.0` (WASM) tarballs on npm predate PR #184 and are missing `resolveManifest`, `isCapabilitySubset`, manifest types, and the `parseRecapFromSiwe` re-export. This empty changeset forces `changeset version` to land on the next beta counter so the Beta Release workflow actually publishes the post-#184 code.

  All four TS packages in the linked group are named explicitly so `@tinycloud/sdk-services` advances too (naming only `@tinycloud/sdk-core` left it pinned at the ghost `2.1.0-beta.0`). Both WASM wrappers take a patch bump so the TS SDKs don't pin a stale `@tinycloud/*-sdk-wasm@1.7.2-beta.0`.

- 61c031d: Add write-hooks support across the JS SDK surface for SDK services, core, Node, and web packages.

### Patch Changes

- b88728a: fix(sdk-core): normalize space URI in recap parse for derivability check

  The Rust WASM `parseRecapFromSiwe` returns `space` as the full recap target
  URI (`tinycloud:pkh:eip155:{chainId}:{address}:{name}`), while manifest
  permissions and backend-advertised permissions use the short `{name}` form
  (e.g. `"default"`). `isCapabilitySubset` was doing strict string comparison
  on `space`, so mixing the two forms always failed — `delegateTo` would throw
  `PermissionNotInManifestError` even when the session recap covered every
  requested capability.

  This broke end-to-end manifest-driven sign-in in the listen app, where the
  session SIWE was signed correctly with the union of all manifest abilities
  but `delegateTo(backendDID, info.permissions)` still failed on the subset
  check because `"tinycloud:pkh:eip155:1:0xd559...:default"` and `"default"`
  didn't match as strings.

  Fix: add a `normalizeSpace` helper that extracts the trailing name segment
  from a `tinycloud:` URI. Apply it in `parseRecapCapabilities` (so the output
  is always in short-name form) and defensively in `isCapabilitySubset` on
  both sides (so callers passing either form work transparently).

- c586568: fix(node-sdk): activate WASM-path delegations with the host so downstream consumers can reference the parent CID

  `createDelegationViaWasmPath` (the session-key UCAN fast path used by
  `tcw.delegateTo` when the requested capabilities are derivable from the
  current session) was building the UCAN client-side and returning it
  directly without posting it to the host. This meant the host's delegation
  store never saw the UCAN.

  When a downstream consumer (e.g. a backend calling `node.useDelegation`)
  tried to reference the UCAN's CID as the parent of its own invoker SIWE,
  the host's chain-validation step failed with "Cannot find parent
  delegation" — the host looks up parents by CID in its local database,
  and the client-side-only UCAN was never stored.

  Fix: after computing the UCAN in `createDelegationViaWasmPath`, call
  `activateSessionWithHost` to POST the delegation header to `/delegate`
  before returning the `PortableDelegation`. This mirrors the legacy
  `createDelegationWalletPath` which has done the same for wallet-signed
  SIWE delegations since day one.

## 2.1.0-beta.4

### Patch Changes

- c586568: fix(node-sdk): activate WASM-path delegations with the host so downstream consumers can reference the parent CID

  `createDelegationViaWasmPath` (the session-key UCAN fast path used by
  `tcw.delegateTo` when the requested capabilities are derivable from the
  current session) was building the UCAN client-side and returning it
  directly without posting it to the host. This meant the host's delegation
  store never saw the UCAN.

  When a downstream consumer (e.g. a backend calling `node.useDelegation`)
  tried to reference the UCAN's CID as the parent of its own invoker SIWE,
  the host's chain-validation step failed with "Cannot find parent
  delegation" — the host looks up parents by CID in its local database,
  and the client-side-only UCAN was never stored.

  Fix: after computing the UCAN in `createDelegationViaWasmPath`, call
  `activateSessionWithHost` to POST the delegation header to `/delegate`
  before returning the `PortableDelegation`. This mirrors the legacy
  `createDelegationWalletPath` which has done the same for wallet-signed
  SIWE delegations since day one.

## 2.1.0-beta.3

### Patch Changes

- b88728a: fix(sdk-core): normalize space URI in recap parse for derivability check

  The Rust WASM `parseRecapFromSiwe` returns `space` as the full recap target
  URI (`tinycloud:pkh:eip155:{chainId}:{address}:{name}`), while manifest
  permissions and backend-advertised permissions use the short `{name}` form
  (e.g. `"default"`). `isCapabilitySubset` was doing strict string comparison
  on `space`, so mixing the two forms always failed — `delegateTo` would throw
  `PermissionNotInManifestError` even when the session recap covered every
  requested capability.

  This broke end-to-end manifest-driven sign-in in the listen app, where the
  session SIWE was signed correctly with the union of all manifest abilities
  but `delegateTo(backendDID, info.permissions)` still failed on the subset
  check because `"tinycloud:pkh:eip155:1:0xd559...:default"` and `"default"`
  didn't match as strings.

  Fix: add a `normalizeSpace` helper that extracts the trailing name segment
  from a `tinycloud:` URI. Apply it in `parseRecapCapabilities` (so the output
  is always in short-name form) and defensively in `isCapabilitySubset` on
  both sides (so callers passing either form work transparently).

## 2.1.0-beta.1

### Minor Changes

- 8abfb4e: Bump past stale `2.1.0-beta.0` / `1.7.2-beta.0` ghost versions to publish PR #184's capability-chain delegation code.

  The earlier `2.1.0-beta.0` (TS SDKs) and `1.7.2-beta.0` (WASM) tarballs on npm predate PR #184 and are missing `resolveManifest`, `isCapabilitySubset`, manifest types, and the `parseRecapFromSiwe` re-export. This empty changeset forces `changeset version` to land on the next beta counter so the Beta Release workflow actually publishes the post-#184 code.

  All four TS packages in the linked group are named explicitly so `@tinycloud/sdk-services` advances too (naming only `@tinycloud/sdk-core` left it pinned at the ghost `2.1.0-beta.0`). Both WASM wrappers take a patch bump so the TS SDKs don't pin a stale `@tinycloud/*-sdk-wasm@1.7.2-beta.0`.

## 2.1.0-beta.0

### Minor Changes

- 61c031d: Add write-hooks support across the JS SDK surface for SDK services, core, Node, and web packages.

## 2.0.3

## 2.0.2

### Patch Changes

- 7bb188f: Fix ESM compatibility by migrating sdk-core and sdk-services from tsc to tsup. Resolves extensionless import errors in Node's strict ESM resolver (e.g. Next.js instrumentation hooks).

## 2.0.1

### Patch Changes

- 75690db: Cache vault signatures in IndexedDB (encrypted with non-extractable AES-GCM CryptoKey) to eliminate repeated wallet popups on unlock. Skip identity signing entirely when public key already exists in public space. Add version-keyed signing constants (VaultVersionConfig) for forward-compatible key derivation. Gracefully no-ops in Node.js.

## 1.7.0

### Minor Changes

- 8649de8: Add `AUTH_UNAUTHORIZED` error code and 401 handling across all services. When the server returns 401 with "Unauthorized Action: {resource} / {ability}", the SDK now parses the response and returns a structured `AUTH_UNAUTHORIZED` error with `requiredAction` and `resource` in meta. Affects KV, SQL, and DuckDB services.
- 8649de8: Add storage quota error handling and TinyCloudQuota helper. New error codes `STORAGE_QUOTA_EXCEEDED` (402) and `STORAGE_LIMIT_REACHED` (413) with quota info parsing in KVService. New `TinyCloudQuota` class for querying quota status from the quota URL discovered via `/info`.

### Patch Changes

- def099d: Skip redundant public key writes on vault unlock and auto-include public-space KV delegation when creating delegations with KV actions. Remove unused VaultAction constants.

## 1.6.0

### Minor Changes

- db50ae4: Add DuckDB service to the TypeScript SDK. Provides `tc.duckdb` for querying and managing DuckDB databases on TinyCloud nodes, including `query()`, `queryArrow()`, `execute()`, `batch()`, `describe()`, `export()`, and `import()` operations. Named database handles via `tc.duckdb.database()`. SDK services are now conditionally initialized based on node feature detection — accessing an unsupported service throws `UnsupportedFeatureError`.

## 1.5.0

### Minor Changes

- 9d6b79f: Add vault.reencrypt() method as the preferred name for vault.grant(). The grant() method is now a deprecated alias that delegates to reencrypt(). Internal revoke() also uses reencrypt().

## 1.3.0

### Minor Changes

- 94ad509: Add Data Vault service for client-side encrypted KV storage with X25519 key exchange and AES-256-GCM encryption

## 1.2.0

### Minor Changes

- ca9b2c6: Add SQL service (tinycloud.sql/\*) with full TypeScript SDK support
  - New SQLService in sdk-services: query, execute, batch, executeStatement, export
  - DatabaseHandle for per-database operations
  - SQL re-exports in sdk-core with TinyCloud.sql getter
  - Node-SDK: SQL wiring in TinyCloudNode, DelegatedAccess, root delegation defaults
  - Fix type-only re-exports preventing bun runtime resolution

## 1.0.0

### Major Changes

- 866981c: # v1.0.0 Release

  ## Protocol Version System
  - Added `checkNodeVersion()` to all sign-in flows for SDK-node compatibility verification
  - Added `ProtocolMismatchError` and `VersionCheckError` error types
  - SDK now requires TinyCloud Node v1.0.0+ with `/version` endpoint

  ## API Surface Cleanup
  - Replaced blanket `export *` with explicit curated exports
  - Renamed 40+ `TCW`-prefixed types (e.g. `TCWClientSession` -> `ClientSession`, `TCWExtension` -> `Extension`)
  - Trimmed internal utilities from public API surface

  ## Breaking Changes
  - All `TCW`-prefixed types have been renamed (drop the `TCW` prefix)
  - Blanket re-exports from `@tinycloudlabs/web-core` removed; use explicit named imports
  - Some internal sdk-core utilities removed from public API
  - `SharingServiceV2` alias removed; use `SharingService` directly
