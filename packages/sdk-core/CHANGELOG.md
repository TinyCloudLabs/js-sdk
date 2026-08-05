# @tinycloudlabs/sdk-core

## 2.11.1-beta.0

### Patch Changes

- 743dba1: Add the SDK-owned `<tinycloud-credential-acquisition>` element and controller
  for first-party inline credential issuance. The Web SDK now renders the
  descriptor-driven ceremony inside the caller's document, reuses the active
  TinyCloud/OpenKey session for holder binding, and keeps OpenCredentials
  transport, verification, durable storage, and proof submission SDK-owned.
  Existing redirect and headless credential-acquisition behavior is unchanged.

## 2.11.0

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

- b5d2e10: Stop browser sign-in hanging forever on an invisible space-creation dialog (TC-362).

  `ModalSpaceCreationHandler.confirmSpaceCreation` returned a promise that only ever
  settled on a click inside a shadow-DOM `<tinycloud-space-modal>`. When that dialog
  was not reachable — for example hidden behind an app's own full-screen "Connecting…"
  overlay — `ensureSpaceExists` awaited it forever and sign-in looked permanently stuck,
  with nothing in the light DOM to explain why.
  - The wait is now bounded (default 2 minutes, configurable via the new
    `TinyCloudWeb` config option `spaceCreationTimeoutMs` or
    `new ModalSpaceCreationHandler({ timeoutMs })`; `0` restores the unbounded wait).
    On expiry the handler closes the dialog and rejects with a `SpaceCreationTimeoutError`
    whose message names the element, the likely cause, and the three ways out.
  - **Behaviour change:** `autoCreateSpace` is now honoured in the browser. `TinyCloudWeb`
    used to install the modal handler unconditionally, and node-sdk gives an explicit
    handler precedence over `autoCreateSpace`, so the option was dead config in the browser.
    `autoCreateSpace: true` now creates the space with no dialog, `autoCreateSpace: false`
    skips creation entirely, and leaving it unset keeps today's modal confirmation.
    An explicit `spaceCreationHandler` still wins over both.
  - While the SDK is blocked on the user it sets
    `data-tinycloud-awaiting-user-input="space-creation"` on `<html>`, fires
    `tinycloud:awaiting-user-input` / `tinycloud:awaiting-user-input-resolved` on `window`,
    and logs an explanatory warning — so a stuck sign-in is diagnosable from outside
    the shadow root. New helper `pendingUserInputKind()` reports the same state.
  - The owner-policy sharing path signs mid-compose by re-opening the wallet/OpenKey
    signing surface. An unanswered or cancelled prompt there used to surface the same
    `PERMISSION_DENIED` "the active session ReCap does not authorize this sharing
    delegation" message as a genuine HTTP 403. It is now reported as `TIMEOUT` or
    `ABORTED` with a message that says what to do, and the underlying error is kept
    as `cause`.

- f0842d8: TC-373: fix two blockers found in review of the batched account-bootstrap seed-spaces write.
  - `KVService.batchPut` now attaches structured metadata (`requestMayHaveDispatched`, and on the two unconfirmed-2xx response paths, `responseReceived` / `status` / `outcome: "batch-unconfirmed"`) to `NETWORK_ERROR`/`TIMEOUT` failures instead of leaving them unclassified. No new `ErrorCodes` member is added — the ambiguity is carried entirely in `meta` to avoid widening the exported `ErrorCode` union.
  - `AccountService.spaces.registerBatch`'s internal ambiguous-failure classifier is now a strict allow-list (previously a deny-list that defaulted to "retry", so deterministic failures like 400/409/422, `INVALID_INPUT`, and 501/505 triggered five pointless per-space reconcile puts). `registerBatch` now returns `RegisterBatchSuccess` (`{ spaces, recoveredFromBatchError? }`) instead of a bare array, so a batch write that recovers via per-space reconciliation is visible on the success payload, not only via `console.warn`.
  - `TinyCloudNode.bootstrapStatus` gains an optional `warnings?: BootstrapWarning[]` field: bootstrap that completes via a recovered ambiguous write is now programmatically distinguishable from a clean run (both were previously `{ skipped: false }`).

  Both changes are additive; nothing published is broken.

- d894c57: TC-393: recover incomplete account bootstrap with a durable account-space
  completion marker, canonical account registry read/create-update/list, delegation,
  capabilities-read, marker, and SQL coverage, and an idempotent
  repair pass. One-shot CoordinationOS OpenKey sessions now explicitly disable
  client-side bootstrap.

### Patch Changes

- 746cb02: Stop implicitly probing `127.0.0.1` during TinyCloud host discovery. Loopback
  discovery now requires an explicit `localNodeUrl`, while configured and
  registry-discovered `*.local.tinycloud.link` nodes continue to work.
- d1d675b: Allow owner delegations to sign exact permissions across TinyCloud services, including the owner encryption network's decrypt capability, while preserving the legacy single-resource API.
- 44ecf56: Release the exact-head session invocation APIs and canonical recipient-DID policy support used by Share.
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

- 9fd8752: Establish the canonical browser- and Node-safe Share envelope codecs and headless SDK foundation. Tracks TC-401's receiveShare parity contract.
- 4ce36a6: Add typed recipient-DID/device authorization, exact-email and domain policy publication/claim resume seams, idempotent notification outcomes, encrypted sender history views, target-aware revocation, and explicit read-only tc1 migration helpers to the canonical Share SDK and CLI.
- 55e76c5: Recognize grouped manifest actions when a verified ReCap returns one capability entry per action.
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

- a7e3668: Sol final-continuation-review fixes on the OpenKey authorization consumer.
  Every claim below corresponds to a delivered test that fails on the prior
  implementation and passes with these changes.

  Requirement 1 — Canonical four-part action IDs across every producer/consumer.

  The on-wire structure of a TinyCloud ReCap resource is
  `<space>/<short-service>[/<sub-path>]`; the WASM `parseRecapFromSiwe`
  emitter strips the `<short-service>` segment out of `entry.path`. The
  prior `signInWithOpenKeyResult` inline resource parser kept the service
  segment INSIDE `path` (e.g. `path="kv"` for a `<space>/kv` resource),
  which produced a canonical four-part ID that never matched what OpenKey
  emits via `computeActionKey` (which uses WASM `entry.path` directly).
  Real production round-trips through the widget → API → js-sdk consumer
  therefore fell through the `grantedFourPartIndex.get(rawKey)` lookup
  silently — Sol explicitly cited this as blocking approval.

  Delivered:
  - `packages/sdk-core/src/authorization/openkey-protocol.ts` exports
    `parseCanonicalRecapResource(resource)` — a pure helper that strips
    the `<short-service>` segment out of `path` for `tinycloud:` URIs and
    returns non-`tinycloud:` URIs unchanged (e.g. raw
    `urn:tinycloud:encryption:...` resources emitted via `rawAbilities`).
  - `NodeUserAuthorization.signInWithOpenKeyResult` uses this helper for
    both `grantedFourPartIndex` construction AND permissions-entry
    resolution. Non-`tinycloud:` URIs are now correctly resolved as
    space-verbatim (no `<short>` reconstruction).
  - Every test helper and integration test that builds four-part IDs from
    a signed SIWE now walks through `parseCanonicalRecapResource` — the
    `signInWithOpenKey.e2e.test.ts` `makeSimulatedOpenKey` bridge and
    the `signInWithOpenKeyResult.test.ts` `deriveSelectedActionKeysFromSiwe`
    and `derivePermissionsFromSiwe` helpers.
  - Tests in
    `packages/sdk-core/src/authorization/openkey-protocol.test.ts::parseCanonicalRecapResource`
    cover: whole-space grant (`path` empty), path-scoped grant (short
    stripped), repeated-space grant (`path` = space), non-tinycloud URN
    passthrough, and a cross-check against hardcoded expected-path values
    that match what real WASM `parseRecapFromSiwe` emits for those URI
    shapes (verified against a real WASM build offline; this test does not
    invoke WASM at runtime). The actual live-WASM evidence is in the
    separate mandatory cross-repository Hono finalize test.

  Requirement 1 (final) — Wire-format acceptance test at the HTTP boundary.

  Sol's final rejection called out that the js-sdk-side round-trip test
  routed through the `wireOpenKeyAuthorize` bridge and never handed a
  byte-shaped Hono `/authorize-sign` finalize body to the REAL
  `signInWithOpenKeyResult` consumer. The bridge translates types but
  does not fabricate any protocol fields — nevertheless, exercising
  the consumer with a directly-constructed wire body proves the
  contract at the exact boundary a compromised OpenKey response could
  attack.

  Delivered:
  - New tests in
    `packages/node-sdk/src/authorization/NodeUserAuthorization.signInWithOpenKeyResult.test.ts`: - `signInWithOpenKeyResult accepts a finalize body in the EXACT
wire shape the Hono /authorize-sign route emits` builds a real
    prepared session via the SDK, signs the exact prepared SIWE
    bytes with the local signer, and assembles a finalize body byte-
    for-byte in the Hono route's response shape (`{ protocolVersion,
address, signature, signedMessage, selectedActionKeys, permissions
}`). Passes DIRECTLY to `signInWithOpenKeyResult` — no bridge, no
    simulator. Asserts the consumer accepts the wire body end-to-end
    and produces a client session with the correct address and
    signed bytes. - `signInWithOpenKeyResult accepts a NARROWED finalize body in the
Hono /authorize-sign wire shape` performs the same test with a
    narrowed SIWE (regenerated via WASM `prepareSession`, which is
    exactly what OpenKey's `narrowSiwePreservingImmutable` calls),
    proving the consumer accepts both the identity round-trip and
    the narrowing round-trip when handed the actual Hono wire body.
  - Companion test on the OpenKey side
    (`apps/api/src/__tests__/delegate-authorize-sign-nodeauth-e2e.test.ts::
finalize body validates against a MIRROR of every
signInWithOpenKeyResult wire-format check`) asserts every wire-
    format guard the SDK consumer runs (protocolVersion, address shape,
    signature-verify, SIWE parseability, canonical four-part IDs, no
    duplicates, non-empty permissions, actions grounded in ATT). Together
    the two tests cover the boundary from BOTH sides using real
    production code paths.

  Requirement 2 — Narrowed OpenKey SIWE accepted by the SDK consumer.

  `WASM.prepareSession` renders the ENTIRE SIWE statement from the ReCap
  contents ("I further authorize the stated URI to perform the following
  actions on my behalf: ..."). Narrowing the ReCap therefore ALWAYS
  changes the statement. The prior `diffImmutableSiweFields` included
  `statement` in the immutable set unconditionally, which caused every
  legitimate narrowing to fail with `altered immutable SIWE fields:
statement` — the exact production round-trip failure Sol cited.

  Delivered:
  - `diffImmutableSiweFields(original, signed, { originalHasRecap })`
    accepts an optional flag. When `originalHasRecap === true`,
    `statement` is EXCLUDED from the diff and the ReCap subset check
    (`unauthorizedRecapCapabilities`) is the authoritative narrowing
    gate. When `originalHasRecap === false` (plain SIWE, no `urn:recap:`
    resource), `statement` remains byte-immutable — a caller-authored
    statement must not silently drift.
  - `NodeUserAuthorization.signInWithOpenKeyResult` computes
    `originalHasRecap` from the prepared SIWE and passes it through.
  - Tests:
    - `NodeUserAuthorization.signInWithOpenKeyResult.test.ts` — a
      narrowed-SIWE-with-ReCap-derived-statement test proves the full
      round-trip completes (was: rejected) AND asserts the pre-condition
      that the statement genuinely differs pre/post narrowing.
    - A contrapositive test proves `diffImmutableSiweFields` still
      rejects statement drift when `originalHasRecap: false`.

  What these changesets do NOT claim:
  - Cross-repo module import: the js-sdk and OpenKey ship independently
    with separate package managers and separate WASM builds. Instead,
    the js-sdk test constructs a Hono-route-shaped finalize body and
    hands it directly to the REAL `signInWithOpenKeyResult` consumer,
    while the matching OpenKey-side test asserts the actual `/authorize-
sign` route emits a response that passes every wire-format check
    the SDK runs. Together the two tests cover the boundary end-to-end.
  - Cross-signing broadening: the strict caveat multiset equality that
    Sol required lives on the OpenKey server side (see the matching
    OpenKey changeset). The js-sdk `unauthorizedRecapCapabilities` was
    already strict — no behaviour change on this side.

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

- 10363b6: Stop pulling the Node `crypto-browserify` polyfill tree (crypto-browserify, elliptic,
  asn1.js, diffie-hellman, public-encrypt, create-ecdh, miller-rabin, bn.js,
  browserify-sign, md5.js, ripemd160, sha.js, hash.js, readable-stream, vm-browserify)
  into downstream browser bundles (TC-291).

  `packages/sdk-core/tsup.config.ts` bundles `multiformats` and the `@multiformats/*`
  packages (`noExternal`) so the published CJS entrypoints don't emit unsupported
  `require()` calls for these ESM-only packages. tsup/esbuild defaults to `platform:
"node"` for that bundling step, which resolves each dependency's `package.json`
  `"exports"`/`"browser"` conditions as Node would — so the _published_ `sdk-core`
  dist ended up with a literal `import crypto from "crypto"` inlined from
  `multiformats/dist/src/hashes/sha2.js`, and a literal `import vm from "vm"` inlined
  from `function-timeout` (reached via `@chainsafe/is-ip`'s `"node"`-conditioned export
  inside `@multiformats/multiaddr`'s IP parsing). No downstream bundler could ever pick
  either package's browser-safe variant, because the Node variant was already baked in
  before the consumer's bundler ever saw the code. Webpack then satisfied the bare
  `crypto`/`vm` imports via its `resolve.fallback` polyfills, dragging in the entire tree.

  Fix: set `platform: "browser"` on the tsup config. This does not externalize anything
  (so the CJS entrypoint constraint that motivated `noExternal` is untouched — it's still
  a single self-contained bundle) — it only changes which `"exports"`/`"browser"`
  conditions esbuild satisfies while resolving the bundled subtree, so `multiformats`
  inlines its WebCrypto-based hasher (`crypto.subtle.digest`) and `@chainsafe/is-ip` /
  `function-timeout` inline their non-Node variants (no `vm`). Node 20+ (this package's
  `engines` floor) ships a global `WebCrypto` (`globalThis.crypto`), so the
  browser-conditioned code runs correctly under Node too — both the ESM and CJS
  entrypoints for every export (`.`, `./bootstrap`, `./policy`, `./requester`,
  `./delegations`) still import and execute cleanly in Node, verified by actually
  calling a `multiformats`-hashing function (`canonicalOwnerSharePolicy`) through each
  built artifact and confirming the CID matches across ESM/CJS.

  Measured with a minimal consumer bundle mirroring `packages/web-sdk/webpack.config.cjs`
  (same `resolve.conditionNames`/`mainFields`/`fallback`, same plugins, `library: {type:
"module"}` output so the imports aren't tree-shaken away) importing
  `@tinycloud/sdk-core` + `@tinycloud/sdk-core/delegations`:

  |         |      Before |     After |
  | ------- | ----------: | --------: |
  | raw     | 1,954,970 B | 857,034 B |
  | gzip -9 |   524,474 B | 248,893 B |

  `crypto-browserify`, the real `elliptic` package, `vm-browserify`, `asn1.js`,
  `browserify-sign`, `diffie-hellman`, `miller-rabin`, `create-ecdh`, and `md5.js` are
  present in the "before" bundle's webpack module graph and entirely absent from
  "after". The one remaining `bn.js`/`elliptic.js` hit after the fix is
  `@ethersproject/signing-key`'s own file (real secp256k1 signing needed by
  `siwe`/`ethers`, unrelated to this polyfill chain).

  This harness was used instead of `packages/web-sdk`'s own build because that
  package's `src/modules/tcw.ts` currently fails to typecheck against the current
  `sdk-core`/`sdk-services` APIs for unrelated, pre-existing reasons (e.g.
  `createOwnerDelegation` vs. the current `createDelegation`, missing
  `@tinycloud/web-sdk-wasm` build output) — worth a look, but out of scope here.

- Updated dependencies [44ecf56]
- Updated dependencies [b38dd12]
- Updated dependencies [68faad4]
- Updated dependencies [17d5662]
- Updated dependencies [2a77ebc]
- Updated dependencies [705685e]
- Updated dependencies [d4ec80a]
- Updated dependencies [1103359]
- Updated dependencies [9fd8752]
- Updated dependencies [4ce36a6]
- Updated dependencies [cc75957]
- Updated dependencies [e525137]
- Updated dependencies [ba9c983]
- Updated dependencies [f0842d8]
- Updated dependencies [d894c57]
- Updated dependencies [7805213]
  - @tinycloud/sdk-services@2.11.0
  - @tinycloud/bootstrap@2.7.0
  - @tinycloud/share-sdk@0.2.0
  - @tinycloud/share-envelope@0.2.0

## 2.11.0-beta.12

### Patch Changes

- Updated dependencies [7805213]
  - @tinycloud/share-envelope@0.2.0-beta.1
  - @tinycloud/share-sdk@0.2.0-beta.2

## 2.11.0-beta.11

### Minor Changes

- d894c57: TC-393: recover incomplete account bootstrap with a durable account-space
  completion marker, canonical account registry read/create-update/list, delegation,
  capabilities-read, marker, and SQL coverage, and an idempotent
  repair pass. One-shot CoordinationOS OpenKey sessions now explicitly disable
  client-side bootstrap.

### Patch Changes

- Updated dependencies [d894c57]
  - @tinycloud/bootstrap@2.7.0-beta.1
  - @tinycloud/sdk-services@2.11.0-beta.11

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

- a7e3668: Sol final-continuation-review fixes on the OpenKey authorization consumer.
  Every claim below corresponds to a delivered test that fails on the prior
  implementation and passes with these changes.

  Requirement 1 — Canonical four-part action IDs across every producer/consumer.

  The on-wire structure of a TinyCloud ReCap resource is
  `<space>/<short-service>[/<sub-path>]`; the WASM `parseRecapFromSiwe`
  emitter strips the `<short-service>` segment out of `entry.path`. The
  prior `signInWithOpenKeyResult` inline resource parser kept the service
  segment INSIDE `path` (e.g. `path="kv"` for a `<space>/kv` resource),
  which produced a canonical four-part ID that never matched what OpenKey
  emits via `computeActionKey` (which uses WASM `entry.path` directly).
  Real production round-trips through the widget → API → js-sdk consumer
  therefore fell through the `grantedFourPartIndex.get(rawKey)` lookup
  silently — Sol explicitly cited this as blocking approval.

  Delivered:
  - `packages/sdk-core/src/authorization/openkey-protocol.ts` exports
    `parseCanonicalRecapResource(resource)` — a pure helper that strips
    the `<short-service>` segment out of `path` for `tinycloud:` URIs and
    returns non-`tinycloud:` URIs unchanged (e.g. raw
    `urn:tinycloud:encryption:...` resources emitted via `rawAbilities`).
  - `NodeUserAuthorization.signInWithOpenKeyResult` uses this helper for
    both `grantedFourPartIndex` construction AND permissions-entry
    resolution. Non-`tinycloud:` URIs are now correctly resolved as
    space-verbatim (no `<short>` reconstruction).
  - Every test helper and integration test that builds four-part IDs from
    a signed SIWE now walks through `parseCanonicalRecapResource` — the
    `signInWithOpenKey.e2e.test.ts` `makeSimulatedOpenKey` bridge and
    the `signInWithOpenKeyResult.test.ts` `deriveSelectedActionKeysFromSiwe`
    and `derivePermissionsFromSiwe` helpers.
  - Tests in
    `packages/sdk-core/src/authorization/openkey-protocol.test.ts::parseCanonicalRecapResource`
    cover: whole-space grant (`path` empty), path-scoped grant (short
    stripped), repeated-space grant (`path` = space), non-tinycloud URN
    passthrough, and a cross-check against hardcoded expected-path values
    that match what real WASM `parseRecapFromSiwe` emits for those URI
    shapes (verified against a real WASM build offline; this test does not
    invoke WASM at runtime). The actual live-WASM evidence is in the
    separate mandatory cross-repository Hono finalize test.

  Requirement 1 (final) — Wire-format acceptance test at the HTTP boundary.

  Sol's final rejection called out that the js-sdk-side round-trip test
  routed through the `wireOpenKeyAuthorize` bridge and never handed a
  byte-shaped Hono `/authorize-sign` finalize body to the REAL
  `signInWithOpenKeyResult` consumer. The bridge translates types but
  does not fabricate any protocol fields — nevertheless, exercising
  the consumer with a directly-constructed wire body proves the
  contract at the exact boundary a compromised OpenKey response could
  attack.

  Delivered:
  - New tests in
    `packages/node-sdk/src/authorization/NodeUserAuthorization.signInWithOpenKeyResult.test.ts`: - `signInWithOpenKeyResult accepts a finalize body in the EXACT
wire shape the Hono /authorize-sign route emits` builds a real
    prepared session via the SDK, signs the exact prepared SIWE
    bytes with the local signer, and assembles a finalize body byte-
    for-byte in the Hono route's response shape (`{ protocolVersion,
address, signature, signedMessage, selectedActionKeys, permissions
}`). Passes DIRECTLY to `signInWithOpenKeyResult` — no bridge, no
    simulator. Asserts the consumer accepts the wire body end-to-end
    and produces a client session with the correct address and
    signed bytes. - `signInWithOpenKeyResult accepts a NARROWED finalize body in the
Hono /authorize-sign wire shape` performs the same test with a
    narrowed SIWE (regenerated via WASM `prepareSession`, which is
    exactly what OpenKey's `narrowSiwePreservingImmutable` calls),
    proving the consumer accepts both the identity round-trip and
    the narrowing round-trip when handed the actual Hono wire body.
  - Companion test on the OpenKey side
    (`apps/api/src/__tests__/delegate-authorize-sign-nodeauth-e2e.test.ts::
finalize body validates against a MIRROR of every
signInWithOpenKeyResult wire-format check`) asserts every wire-
    format guard the SDK consumer runs (protocolVersion, address shape,
    signature-verify, SIWE parseability, canonical four-part IDs, no
    duplicates, non-empty permissions, actions grounded in ATT). Together
    the two tests cover the boundary from BOTH sides using real
    production code paths.

  Requirement 2 — Narrowed OpenKey SIWE accepted by the SDK consumer.

  `WASM.prepareSession` renders the ENTIRE SIWE statement from the ReCap
  contents ("I further authorize the stated URI to perform the following
  actions on my behalf: ..."). Narrowing the ReCap therefore ALWAYS
  changes the statement. The prior `diffImmutableSiweFields` included
  `statement` in the immutable set unconditionally, which caused every
  legitimate narrowing to fail with `altered immutable SIWE fields:
statement` — the exact production round-trip failure Sol cited.

  Delivered:
  - `diffImmutableSiweFields(original, signed, { originalHasRecap })`
    accepts an optional flag. When `originalHasRecap === true`,
    `statement` is EXCLUDED from the diff and the ReCap subset check
    (`unauthorizedRecapCapabilities`) is the authoritative narrowing
    gate. When `originalHasRecap === false` (plain SIWE, no `urn:recap:`
    resource), `statement` remains byte-immutable — a caller-authored
    statement must not silently drift.
  - `NodeUserAuthorization.signInWithOpenKeyResult` computes
    `originalHasRecap` from the prepared SIWE and passes it through.
  - Tests:
    - `NodeUserAuthorization.signInWithOpenKeyResult.test.ts` — a
      narrowed-SIWE-with-ReCap-derived-statement test proves the full
      round-trip completes (was: rejected) AND asserts the pre-condition
      that the statement genuinely differs pre/post narrowing.
    - A contrapositive test proves `diffImmutableSiweFields` still
      rejects statement drift when `originalHasRecap: false`.

  What these changesets do NOT claim:
  - Cross-repo module import: the js-sdk and OpenKey ship independently
    with separate package managers and separate WASM builds. Instead,
    the js-sdk test constructs a Hono-route-shaped finalize body and
    hands it directly to the REAL `signInWithOpenKeyResult` consumer,
    while the matching OpenKey-side test asserts the actual `/authorize-
sign` route emits a response that passes every wire-format check
    the SDK runs. Together the two tests cover the boundary end-to-end.
  - Cross-signing broadening: the strict caveat multiset equality that
    Sol required lives on the OpenKey server side (see the matching
    OpenKey changeset). The js-sdk `unauthorizedRecapCapabilities` was
    already strict — no behaviour change on this side.

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

- Updated dependencies [b38dd12]
- Updated dependencies [cc75957]
- Updated dependencies [e525137]
- Updated dependencies [ba9c983]
  - @tinycloud/sdk-services@2.11.0-beta.10

## 2.11.0-beta.9

### Patch Changes

- 10363b6: Stop pulling the Node `crypto-browserify` polyfill tree (crypto-browserify, elliptic,
  asn1.js, diffie-hellman, public-encrypt, create-ecdh, miller-rabin, bn.js,
  browserify-sign, md5.js, ripemd160, sha.js, hash.js, readable-stream, vm-browserify)
  into downstream browser bundles (TC-291).

  `packages/sdk-core/tsup.config.ts` bundles `multiformats` and the `@multiformats/*`
  packages (`noExternal`) so the published CJS entrypoints don't emit unsupported
  `require()` calls for these ESM-only packages. tsup/esbuild defaults to `platform:
"node"` for that bundling step, which resolves each dependency's `package.json`
  `"exports"`/`"browser"` conditions as Node would — so the _published_ `sdk-core`
  dist ended up with a literal `import crypto from "crypto"` inlined from
  `multiformats/dist/src/hashes/sha2.js`, and a literal `import vm from "vm"` inlined
  from `function-timeout` (reached via `@chainsafe/is-ip`'s `"node"`-conditioned export
  inside `@multiformats/multiaddr`'s IP parsing). No downstream bundler could ever pick
  either package's browser-safe variant, because the Node variant was already baked in
  before the consumer's bundler ever saw the code. Webpack then satisfied the bare
  `crypto`/`vm` imports via its `resolve.fallback` polyfills, dragging in the entire tree.

  Fix: set `platform: "browser"` on the tsup config. This does not externalize anything
  (so the CJS entrypoint constraint that motivated `noExternal` is untouched — it's still
  a single self-contained bundle) — it only changes which `"exports"`/`"browser"`
  conditions esbuild satisfies while resolving the bundled subtree, so `multiformats`
  inlines its WebCrypto-based hasher (`crypto.subtle.digest`) and `@chainsafe/is-ip` /
  `function-timeout` inline their non-Node variants (no `vm`). Node 20+ (this package's
  `engines` floor) ships a global `WebCrypto` (`globalThis.crypto`), so the
  browser-conditioned code runs correctly under Node too — both the ESM and CJS
  entrypoints for every export (`.`, `./bootstrap`, `./policy`, `./requester`,
  `./delegations`) still import and execute cleanly in Node, verified by actually
  calling a `multiformats`-hashing function (`canonicalOwnerSharePolicy`) through each
  built artifact and confirming the CID matches across ESM/CJS.

  Measured with a minimal consumer bundle mirroring `packages/web-sdk/webpack.config.cjs`
  (same `resolve.conditionNames`/`mainFields`/`fallback`, same plugins, `library: {type:
"module"}` output so the imports aren't tree-shaken away) importing
  `@tinycloud/sdk-core` + `@tinycloud/sdk-core/delegations`:

  |         |      Before |     After |
  | ------- | ----------: | --------: |
  | raw     | 1,954,970 B | 857,034 B |
  | gzip -9 |   524,474 B | 248,893 B |

  `crypto-browserify`, the real `elliptic` package, `vm-browserify`, `asn1.js`,
  `browserify-sign`, `diffie-hellman`, `miller-rabin`, `create-ecdh`, and `md5.js` are
  present in the "before" bundle's webpack module graph and entirely absent from
  "after". The one remaining `bn.js`/`elliptic.js` hit after the fix is
  `@ethersproject/signing-key`'s own file (real secp256k1 signing needed by
  `siwe`/`ethers`, unrelated to this polyfill chain).

  This harness was used instead of `packages/web-sdk`'s own build because that
  package's `src/modules/tcw.ts` currently fails to typecheck against the current
  `sdk-core`/`sdk-services` APIs for unrelated, pre-existing reasons (e.g.
  `createOwnerDelegation` vs. the current `createDelegation`, missing
  `@tinycloud/web-sdk-wasm` build output) — worth a look, but out of scope here.

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
  - @tinycloud/sdk-services@2.11.0-beta.8

## 2.11.0-beta.7

### Patch Changes

- 44ecf56: Release the exact-head session invocation APIs and canonical recipient-DID policy support used by Share.
- 9fd8752: Establish the canonical browser- and Node-safe Share envelope codecs and headless SDK foundation. Tracks TC-401's receiveShare parity contract.
- 4ce36a6: Add typed recipient-DID/device authorization, exact-email and domain policy publication/claim resume seams, idempotent notification outcomes, encrypted sender history views, target-aware revocation, and explicit read-only tc1 migration helpers to the canonical Share SDK and CLI.
- Updated dependencies [44ecf56]
- Updated dependencies [17d5662]
- Updated dependencies [2a77ebc]
- Updated dependencies [705685e]
- Updated dependencies [d4ec80a]
- Updated dependencies [1103359]
- Updated dependencies [9fd8752]
- Updated dependencies [4ce36a6]
  - @tinycloud/sdk-services@2.11.0-beta.7
  - @tinycloud/share-sdk@0.2.0-beta.0
  - @tinycloud/share-envelope@0.2.0-beta.0

## 2.11.0-beta.5

### Minor Changes

- f0842d8: TC-373: fix two blockers found in review of the batched account-bootstrap seed-spaces write.
  - `KVService.batchPut` now attaches structured metadata (`requestMayHaveDispatched`, and on the two unconfirmed-2xx response paths, `responseReceived` / `status` / `outcome: "batch-unconfirmed"`) to `NETWORK_ERROR`/`TIMEOUT` failures instead of leaving them unclassified. No new `ErrorCodes` member is added — the ambiguity is carried entirely in `meta` to avoid widening the exported `ErrorCode` union.
  - `AccountService.spaces.registerBatch`'s internal ambiguous-failure classifier is now a strict allow-list (previously a deny-list that defaulted to "retry", so deterministic failures like 400/409/422, `INVALID_INPUT`, and 501/505 triggered five pointless per-space reconcile puts). `registerBatch` now returns `RegisterBatchSuccess` (`{ spaces, recoveredFromBatchError? }`) instead of a bare array, so a batch write that recovers via per-space reconciliation is visible on the success payload, not only via `console.warn`.
  - `TinyCloudNode.bootstrapStatus` gains an optional `warnings?: BootstrapWarning[]` field: bootstrap that completes via a recovered ambiguous write is now programmatically distinguishable from a clean run (both were previously `{ skipped: false }`).

  Both changes are additive; nothing published is broken.

### Patch Changes

- Updated dependencies [f0842d8]
  - @tinycloud/sdk-services@2.11.0-beta.5

## 2.11.0-beta.4

### Patch Changes

- 746cb02: Stop implicitly probing `127.0.0.1` during TinyCloud host discovery. Loopback
  discovery now requires an explicit `localNodeUrl`, while configured and
  registry-discovered `*.local.tinycloud.link` nodes continue to work.

## 2.11.0-beta.3

### Patch Changes

- 55e76c5: Recognize grouped manifest actions when a verified ReCap returns one capability entry per action.

## 2.11.0-beta.1

### Patch Changes

- d1d675b: Allow owner delegations to sign exact permissions across TinyCloud services, including the owner encryption network's decrypt capability, while preserving the legacy single-resource API.

## 2.11.0-beta.0

### Minor Changes

- b5d2e10: Stop browser sign-in hanging forever on an invisible space-creation dialog (TC-362).

  `ModalSpaceCreationHandler.confirmSpaceCreation` returned a promise that only ever
  settled on a click inside a shadow-DOM `<tinycloud-space-modal>`. When that dialog
  was not reachable — for example hidden behind an app's own full-screen "Connecting…"
  overlay — `ensureSpaceExists` awaited it forever and sign-in looked permanently stuck,
  with nothing in the light DOM to explain why.
  - The wait is now bounded (default 2 minutes, configurable via the new
    `TinyCloudWeb` config option `spaceCreationTimeoutMs` or
    `new ModalSpaceCreationHandler({ timeoutMs })`; `0` restores the unbounded wait).
    On expiry the handler closes the dialog and rejects with a `SpaceCreationTimeoutError`
    whose message names the element, the likely cause, and the three ways out.
  - **Behaviour change:** `autoCreateSpace` is now honoured in the browser. `TinyCloudWeb`
    used to install the modal handler unconditionally, and node-sdk gives an explicit
    handler precedence over `autoCreateSpace`, so the option was dead config in the browser.
    `autoCreateSpace: true` now creates the space with no dialog, `autoCreateSpace: false`
    skips creation entirely, and leaving it unset keeps today's modal confirmation.
    An explicit `spaceCreationHandler` still wins over both.
  - While the SDK is blocked on the user it sets
    `data-tinycloud-awaiting-user-input="space-creation"` on `<html>`, fires
    `tinycloud:awaiting-user-input` / `tinycloud:awaiting-user-input-resolved` on `window`,
    and logs an explanatory warning — so a stuck sign-in is diagnosable from outside
    the shadow root. New helper `pendingUserInputKind()` reports the same state.
  - The owner-policy sharing path signs mid-compose by re-opening the wallet/OpenKey
    signing surface. An unanswered or cancelled prompt there used to surface the same
    `PERMISSION_DENIED` "the active session ReCap does not authorize this sharing
    delegation" message as a genuine HTTP 403. It is now reported as `TIMEOUT` or
    `ABORTED` with a message that says what to do, and the underlying error is kept
    as `cause`.

## 2.10.0

### Minor Changes

- 28cc430: Add batch KV reads and memoize TinyCloud node descriptor lookups to reduce SDK round trips.

### Patch Changes

- 48a5408: Coalesce concurrent identical session activations into a single `POST /delegate` (TC-332).

  `activateSessionWithHost` had no de-duplication, so the ~17 call sites that replay a
  byte-identical session delegation header — registry sync, space-hosting hooks and their
  retry wrappers, several of which fire without awaiting each other — could issue the same
  request concurrently. A parentless root session delegation acquires no chain guard locks on
  the node, and PostgreSQL deployments have no `writer_lock` to serialize writes, so two
  identical concurrent requests compute the same `epoch_hash`, both insert into `epoch`, and
  the loser fails with a unique-constraint violation surfaced as HTTP 500.

  Concurrent callers with the same host and header now share one in-flight request. Only
  in-flight promises are shared, never completed results, so sequential calls still issue a
  fresh request and a revoked session is never masked by a cached success. A caller that
  joins a request which then fails at the network level gets its own second attempt rather
  than inheriting a failure it did not cause.

- Updated dependencies [28cc430]
  - @tinycloud/sdk-services@2.10.0

## 2.10.0-beta.1

### Patch Changes

- 48a5408: Coalesce concurrent identical session activations into a single `POST /delegate` (TC-332).

  `activateSessionWithHost` had no de-duplication, so the ~17 call sites that replay a
  byte-identical session delegation header — registry sync, space-hosting hooks and their
  retry wrappers, several of which fire without awaiting each other — could issue the same
  request concurrently. A parentless root session delegation acquires no chain guard locks on
  the node, and PostgreSQL deployments have no `writer_lock` to serialize writes, so two
  identical concurrent requests compute the same `epoch_hash`, both insert into `epoch`, and
  the loser fails with a unique-constraint violation surfaced as HTTP 500.

  Concurrent callers with the same host and header now share one in-flight request. Only
  in-flight promises are shared, never completed results, so sequential calls still issue a
  fresh request and a revoked session is never masked by a cached success. A caller that
  joins a request which then fails at the network level gets its own second attempt rather
  than inheriting a failure it did not cause.

## Unreleased

### Minor Changes

- Add the signed v2 share-envelope/link codec, compact CID and bounded inline
  resolution, verified ciphertext cache, local capability intersection, and
  `ShareRecipientClient`. The legacy `tc1` `SharingService.receive` path is
  unchanged; v2 callers use `receiveV2` and explicit `ShareAccessV2` methods.

## 2.10.0-beta.0

### Minor Changes

- 28cc430: Add batch KV reads and memoize TinyCloud node descriptor lookups to reduce SDK round trips.

### Patch Changes

- Updated dependencies [28cc430]
  - @tinycloud/sdk-services@2.10.0-beta.0

## 2.9.0

### Minor Changes

- 9afb09c: Add localhost-first node resolution with identity pinning. Before falling back to registry/hosted resolution, `resolveTinyCloudHosts` now probes for a locally-running TinyCloud node (loopback, then `*.local.tinycloud.link`) and uses it if it answers and passes DID identity verification (trust-on-first-use, pinned per consumer). New opt-out and config knobs: `autoDiscoverLocalNode` (default true), `localNodeUrl`, `localLinkName`, `expectedNodeDid`, surfaced on node-sdk, web-sdk, and the CLI. Explicit host configuration (`host`, `--host`/`TC_HOST`) continues to skip discovery entirely.

## 2.8.0

### Patch Changes

- Updated dependencies [7ecd455]
- Updated dependencies [7ecd455]
  - @tinycloud/sdk-services@2.8.0

## 2.8.0-beta.0

### Patch Changes

- Updated dependencies [7ecd455]
- Updated dependencies [7ecd455]
  - @tinycloud/sdk-services@2.8.0-beta.0

## 2.7.0

### Minor Changes

- f7a1d4f: Add signed account-wide delegation history queries with lifecycle and revocation
  status, plus CID-bound delegation revocation receipts and the account-scoped
  delegation control capabilities used by SDK sessions.
- 4dee0a9: Add `sharing.delegateReceivedShare`, which exchanges a received `tc1` sharing
  link for a strictly attenuated child delegation without exposing the parent
  link or its embedded private key. Node `receive` now uses the same primitive
  when auto-subdelegating to its current session key. Delegation revocation can
  now be included in a consolidated manifest and uses the node's revocation
  endpoint so descendants are invalidated rather than recording a no-op invoke.
  The SDK also exposes node-confirmed delegation lifecycle status without
  returning delegation metadata.

### Patch Changes

- f5b1c75: Repair I2 release artifacts: bundle ESM-only multiformats dependencies for Node CommonJS consumers, preserve safe delegation mismatch details, and publish the canonical CLI auth import route.
- b982b90: Declare Node 20 or newer as the supported runtime floor for the complete published SDK and Operations graph, including the CLI and Node WASM bindings.
- 160c16e: Canonicalize JSON object keys using RFC 8785 raw UTF-16 code-unit ordering,
  including astral-plane keys. Update operations' exact sdk-core dependency at
  release so retry digests use the corrected canonicalization.
- d6d5ef1: Restore persisted sessions with their original private Ed25519 signer. Verify the signed SIWE, ReCap, Cacao header/CID, address, chain, session DID, and expiry before installing authority; atomically replace the auth/core/service host context while retaining every live secondary signer. Retired service graphs abort outstanding work and cannot reuse old encryption authority. Browser restore now preserves spaces and policy expiry, and rejected restores leave persisted storage untouched.
- cd8c11f: Add an explicit-space classified secret-read API that preserves safe KV,
  envelope, decrypt, and payload failure phases without changing legacy secret
  reads.
- Updated dependencies [940ff1d]
- Updated dependencies [f7a1d4f]
- Updated dependencies [b982b90]
- Updated dependencies [d6d5ef1]
- Updated dependencies [cd8c11f]
  - @tinycloud/bootstrap@2.6.0
  - @tinycloud/sdk-services@2.7.0

## 2.7.0-beta.4

### Patch Changes

- f5b1c75: Repair I2 release artifacts: bundle ESM-only multiformats dependencies for Node CommonJS consumers, preserve safe delegation mismatch details, and publish the canonical CLI auth import route.
- b982b90: Declare Node 20 or newer as the supported runtime floor for the complete published SDK and Operations graph, including the CLI and Node WASM bindings.
- 160c16e: Canonicalize JSON object keys using RFC 8785 raw UTF-16 code-unit ordering,
  including astral-plane keys. Update operations' exact sdk-core dependency at
  release so retry digests use the corrected canonicalization.
- d6d5ef1: Restore persisted sessions with their original private Ed25519 signer. Verify the signed SIWE, ReCap, Cacao header/CID, address, chain, session DID, and expiry before installing authority; atomically replace the auth/core/service host context while retaining every live secondary signer. Retired service graphs abort outstanding work and cannot reuse old encryption authority. Browser restore now preserves spaces and policy expiry, and rejected restores leave persisted storage untouched.
- cd8c11f: Add an explicit-space classified secret-read API that preserves safe KV,
  envelope, decrypt, and payload failure phases without changing legacy secret
  reads.
- Updated dependencies [940ff1d]
- Updated dependencies [b982b90]
- Updated dependencies [d6d5ef1]
- Updated dependencies [cd8c11f]
  - @tinycloud/bootstrap@2.6.0-beta.1
  - @tinycloud/sdk-services@2.7.0-beta.4

## 2.7.0-beta.3

### Minor Changes

- f7a1d4f: Add signed account-wide delegation history queries with lifecycle and revocation
  status, plus CID-bound delegation revocation receipts and the account-scoped
  delegation control capabilities used by SDK sessions.

### Patch Changes

- Updated dependencies [f7a1d4f]
  - @tinycloud/bootstrap@2.6.0-beta.0
  - @tinycloud/sdk-services@2.7.0-beta.3

## 2.7.0-beta.2

### Minor Changes

- 4dee0a9: Add `sharing.delegateReceivedShare`, which exchanges a received `tc1` sharing
  link for a strictly attenuated child delegation without exposing the parent
  link or its embedded private key. Node `receive` now uses the same primitive
  when auto-subdelegating to its current session key. Delegation revocation can
  now be included in a consolidated manifest and uses the node's revocation
  endpoint so descendants are invalidated rather than recording a no-op invoke.
  The SDK also exposes node-confirmed delegation lifecycle status without
  returning delegation metadata.

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

- Updated dependencies [3841be4]
  - @tinycloud/sdk-services@2.6.3

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

- Updated dependencies [3841be4]
  - @tinycloud/sdk-services@2.6.3-beta.0

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

- Updated dependencies [b4d1e45]
  - @tinycloud/sdk-services@2.6.2

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

- Updated dependencies [b4d1e45]
  - @tinycloud/sdk-services@2.6.2-beta.0

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
- Updated dependencies [bf31506]
  - @tinycloud/bootstrap@2.5.1
  - @tinycloud/sdk-services@2.6.1

## 2.6.1-beta.1

### Patch Changes

- Updated dependencies [cd2aeb1]
  - @tinycloud/bootstrap@2.5.1-beta.0
  - @tinycloud/sdk-services@2.6.1-beta.1

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

- Updated dependencies [bf31506]
  - @tinycloud/sdk-services@2.6.1-beta.0

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

- Updated dependencies [ac48f85]
- Updated dependencies [2f31800]
- Updated dependencies [3ad0635]
- Updated dependencies [e07823b]
  - @tinycloud/sdk-services@2.6.0
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

- Updated dependencies [e07823b]
  - @tinycloud/sdk-services@2.6.0-beta.3

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

- Updated dependencies [3ad0635]
  - @tinycloud/sdk-services@2.6.0-beta.2

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

- Updated dependencies [ac48f85]
  - @tinycloud/sdk-services@2.6.0-beta.1

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
  - @tinycloud/sdk-services@2.6.0-beta.0

## 2.5.1

### Patch Changes

- Updated dependencies [3b23940]
  - @tinycloud/bootstrap@2.4.1
  - @tinycloud/sdk-services@2.4.2

## 2.5.1-beta.0

### Patch Changes

- Updated dependencies [3b23940]
  - @tinycloud/bootstrap@2.4.1-beta.0

## 2.5.0

### Minor Changes

- dda499e: TC-86: browser auto-sign bootstrap support. `TinyCloudWeb` config accepts `signStrategy` and forwards it to `TinyCloudNode`, sign requests carry a `purpose` tag (`sign-in` / `bootstrap-session` / `bootstrap-host` / `message`) so strategies can route bootstrap signatures to OpenKey's server-side signer, and account-bootstrap failures degrade to a skipped bootstrap surfaced via `bootstrapStatus` instead of failing `signIn()`.

### Patch Changes

- @tinycloud/sdk-services@2.4.1

## 2.5.0-beta.1

### Minor Changes

- dda499e: TC-86: browser auto-sign bootstrap support. `TinyCloudWeb` config accepts `signStrategy` and forwards it to `TinyCloudNode`, sign requests carry a `purpose` tag (`sign-in` / `bootstrap-session` / `bootstrap-host` / `message`) so strategies can route bootstrap signatures to OpenKey's server-side signer, and account-bootstrap failures degrade to a skipped bootstrap surfaced via `bootstrapStatus` instead of failing `signIn()`.

## 2.4.0

### Minor Changes

- 6b554d6: Add shared account APIs for applications and delegations, expose them from the node and web SDK clients, and add the `tc account` CLI command group.
- 75bebb1: Add account registry write-through indexing, account space registry APIs, and matching `tc account spaces` / `tc account index status` CLI commands.

  Manifest registration now records an indexed manifest hash and skips durable KV rewrites when the indexed record is current. Sign-in schedules best-effort background registry sync for application manifests and accessible spaces, while every discovered or hosted space is written through to the account registry index.

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

- 0d397a8: Treat the account SQLite index as a materialized cache for user-facing account reads. Account application, space, and delegation list calls can now prefer the index while falling back to canonical account data when index tables are missing or empty, and account writes no longer fail when a best-effort index update fails.
- 895804a: Include `tinycloud.sql/ddl` in the implicit account registry index permission and legacy default SQL grant so account registry writes can create their SQLite tables and indexes on first use. SQL execute and batch calls now sign DDL statements with `tinycloud.sql/ddl`, and mixed batches sign with every required SQL action instead of collapsing to write-only.
- 6622043: Expose `account.index.ensure()` and `tc account index ensure` for lightweight account SQLite schema bootstrap, and start schema bootstrap with background account registry sync.
- 79dd26c: Add the canonical account bootstrap manifest package, shared bootstrap schemas/allowlist, OpenKey callback signing strategy, and first-sign-in SDK bootstrap orchestration for enshrined spaces.
- 7603d1f: Support concise app manifest knowledge pointers. The SDK now validates `knowledge: true` and `knowledge/*.md` roots, exposes a helper for resolving the effective knowledge root, and `tc manifest resolve` includes that root in its output.
- d4a0a69: Add a SQL migrations helper on database handles: `sql.db(name).migrations.apply({ namespace, migrations })`. The helper records applied migration ids in a TinyCloud-managed table, signs migration DDL/write/read actions through the SQL service, and returns whether migrations were applied or already current.

  The account registry index now uses the migrations helper for its schema setup, and SQL/DuckDB service errors sanitize non-JSON proxy HTML pages into concise retryable messages while preserving a bounded debug snippet in error metadata.

- a22a7f0: Rename the SDK-emitted SQL schema-change permission from `tinycloud.sql/ddl` to `tinycloud.sql/schema`, including manifest defaults and account-registry grants.

  TinyCloudWeb now treats a restored persisted session as stale when it does not cover the currently configured manifest permissions, then runs the normal manifest sign-in flow instead of letting apps request those manifest permissions separately after login.

- 42f1235: Add an opt-in TinyCloud debug logger controlled by `TinyCloud_debug`. The logger keeps a 1000-event in-memory ring buffer, writes structured events to `console.debug` when enabled, exposes browser console helpers for enabling, disabling, inspecting, and clearing logs, persists browser debug mode through `localStorage`, and captures service events plus `fetch`, `invoke`, and `invokeAny` timings.
- Updated dependencies [895804a]
- Updated dependencies [934534d]
- Updated dependencies [79dd26c]
- Updated dependencies [bd8a60f]
- Updated dependencies [eb44380]
- Updated dependencies [c94b81b]
- Updated dependencies [27f97d8]
- Updated dependencies [aa050d1]
- Updated dependencies [fa4a7c7]
- Updated dependencies [d4a0a69]
- Updated dependencies [a22a7f0]
- Updated dependencies [42f1235]
  - @tinycloud/sdk-services@2.4.0
  - @tinycloud/bootstrap@2.4.0

## 2.4.0-beta.19

### Patch Changes

- 42f1235: Add an opt-in TinyCloud debug logger controlled by `TinyCloud_debug`. The logger keeps a 1000-event in-memory ring buffer, writes structured events to `console.debug` when enabled, exposes browser console helpers for enabling, disabling, inspecting, and clearing logs, persists browser debug mode through `localStorage`, and captures service events plus `fetch`, `invoke`, and `invokeAny` timings.
- Updated dependencies [42f1235]
  - @tinycloud/sdk-services@2.4.0-beta.19

## 2.4.0-beta.17

### Patch Changes

- 6622043: Expose `account.index.ensure()` and `tc account index ensure` for lightweight account SQLite schema bootstrap, and start schema bootstrap with background account registry sync.

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

### Patch Changes

- Updated dependencies [eb44380]
  - @tinycloud/sdk-services@2.4.0-beta.16

## 2.4.0-beta.15

### Patch Changes

- Updated dependencies [bd8a60f]
  - @tinycloud/sdk-services@2.4.0-beta.15

## 2.4.0-beta.14

### Patch Changes

- a22a7f0: Rename the SDK-emitted SQL schema-change permission from `tinycloud.sql/ddl` to `tinycloud.sql/schema`, including manifest defaults and account-registry grants.

  TinyCloudWeb now treats a restored persisted session as stale when it does not cover the currently configured manifest permissions, then runs the normal manifest sign-in flow instead of letting apps request those manifest permissions separately after login.

- Updated dependencies [a22a7f0]
  - @tinycloud/sdk-services@2.4.0-beta.14

## 2.4.0-beta.13

### Patch Changes

- 7603d1f: Support concise app manifest knowledge pointers. The SDK now validates `knowledge: true` and `knowledge/*.md` roots, exposes a helper for resolving the effective knowledge root, and `tc manifest resolve` includes that root in its output.

## 2.4.0-beta.12

### Patch Changes

- Updated dependencies [fa4a7c7]
  - @tinycloud/sdk-services@2.4.0-beta.12

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

### Patch Changes

- Updated dependencies [aa050d1]
  - @tinycloud/sdk-services@2.4.0-beta.11

## 2.4.0-beta.10

### Minor Changes

- 27f97d8: Add a public `ensureOwnedSpaceHosted(name)` method to `TinyCloudNode` and `TinyCloudWeb` for hosting an owner's owned space (e.g. `"secrets"`) from a session created with a manifest / capabilityRequest.

  A full-authority sign-in auto-hosts the owner's `secrets` space, but a session created with a manifest / capabilityRequest does not. Such a session could hold valid `tinycloud.kv/*` capabilities for the owned `secrets` space yet still fail its first scoped `secrets.put(...)` with `404 Space not found`, because the space was never registered on the node. `ensureOwnedSpaceHosted(name)` resolves the name to the owner's owned-space URI and hosts it via the host-SIWE delegation flow (one signature, idempotent server-side), so subsequent scoped secret writes succeed.

### Patch Changes

- d4a0a69: Add a SQL migrations helper on database handles: `sql.db(name).migrations.apply({ namespace, migrations })`. The helper records applied migration ids in a TinyCloud-managed table, signs migration DDL/write/read actions through the SQL service, and returns whether migrations were applied or already current.

  The account registry index now uses the migrations helper for its schema setup, and SQL/DuckDB service errors sanitize non-JSON proxy HTML pages into concise retryable messages while preserving a bounded debug snippet in error metadata.

- Updated dependencies [27f97d8]
- Updated dependencies [d4a0a69]
  - @tinycloud/sdk-services@2.4.0-beta.10

## 2.4.0-beta.9

### Patch Changes

- 0d397a8: Treat the account SQLite index as a materialized cache for user-facing account reads. Account application, space, and delegation list calls can now prefer the index while falling back to canonical account data when index tables are missing or empty, and account writes no longer fail when a best-effort index update fails.

## 2.4.0-beta.8

### Patch Changes

- 895804a: Include `tinycloud.sql/ddl` in the implicit account registry index permission and legacy default SQL grant so account registry writes can create their SQLite tables and indexes on first use. SQL execute and batch calls now sign DDL statements with `tinycloud.sql/ddl`, and mixed batches sign with every required SQL action instead of collapsing to write-only.
- Updated dependencies [895804a]
  - @tinycloud/sdk-services@2.4.0-beta.8

## 2.4.0-beta.7

### Minor Changes

- 75bebb1: Add account registry write-through indexing, account space registry APIs, and matching `tc account spaces` / `tc account index status` CLI commands.

  Manifest registration now records an indexed manifest hash and skips durable KV rewrites when the indexed record is current. Sign-in schedules best-effort background registry sync for application manifests and accessible spaces, while every discovered or hosted space is written through to the account registry index.

## 2.4.0-beta.6

### Minor Changes

- 6b554d6: Add shared account APIs for applications and delegations, expose them from the node and web SDK clients, and add the `tc account` CLI command group.

## 2.4.0-beta.2

### Patch Changes

- Updated dependencies [934534d]
  - @tinycloud/sdk-services@2.4.0-beta.2

## 2.4.0-beta.1

### Patch Changes

- Updated dependencies [c94b81b]
  - @tinycloud/sdk-services@2.4.0-beta.1

## 2.3.0

### Minor Changes

- fb96a1e: Rename owner/delegate identity surfaces from primary/principal terminology to owner terminology.

  CLI profiles and auth request artifacts now use `ownerDid` and `sessionDid`. Encryption network descriptors and discovery APIs now expose the owner identity as `ownerDid`.

- c7676d6: Add `kv.batchPut` for one-invocation TinyCloud KV batch writes.

### Patch Changes

- a92819d: Add canonical EVM address and `did:pkh:eip155` helpers, then use them when building and comparing TinyCloud DIDs and space IDs.
- 90bdc18: Add canonical encryption network ID helpers so apps can compare network-scoped capabilities across equivalent owner DID address casing.
- f11e468: Add default-off telemetry configuration and named span timing events for SDK operations.
- Updated dependencies [9ee7404]
- Updated dependencies [fb96a1e]
- Updated dependencies [d606baf]
- Updated dependencies [945f43c]
- Updated dependencies [c7676d6]
- Updated dependencies [f11e468]
  - @tinycloud/sdk-services@2.3.0

## 2.3.0-beta.8

### Patch Changes

- f11e468: Add default-off telemetry configuration and named span timing events for SDK operations.
- Updated dependencies [f11e468]
  - @tinycloud/sdk-services@2.3.0-beta.8

## 2.3.0-beta.7

### Patch Changes

- Updated dependencies [945f43c]
  - @tinycloud/sdk-services@2.3.0-beta.7

## 2.3.0-beta.6

### Minor Changes

- c7676d6: Add `kv.batchPut` for one-invocation TinyCloud KV batch writes.

### Patch Changes

- Updated dependencies [c7676d6]
  - @tinycloud/sdk-services@2.3.0-beta.6

## 2.3.0-beta.5

### Patch Changes

- Updated dependencies [d606baf]
  - @tinycloud/sdk-services@2.3.0-beta.5

## 2.3.0-beta.4

### Patch Changes

- 90bdc18: Add canonical encryption network ID helpers so apps can compare network-scoped capabilities across equivalent owner DID address casing.

## 2.3.0-beta.3

### Patch Changes

- a92819d: Add canonical EVM address and `did:pkh:eip155` helpers, then use them when building and comparing TinyCloud DIDs and space IDs.

## 2.3.0-beta.2

### Minor Changes

- fb96a1e: Rename owner/delegate identity surfaces from primary/principal terminology to owner terminology.

  CLI profiles and auth request artifacts now use `ownerDid` and `sessionDid`. Encryption network descriptors and discovery APIs now expose the owner identity as `ownerDid`.

### Patch Changes

- Updated dependencies [fb96a1e]
  - @tinycloud/sdk-services@2.3.0-beta.2

## 2.2.1-beta.0

### Patch Changes

- Updated dependencies [9ee7404]
  - @tinycloud/sdk-services@2.2.1-beta.0

## 2.2.0

### Minor Changes

- 0401ff8: Add default TinyCloud host discovery and run it from sign-in when no explicit host is configured.
- 9ff4b34: Introduce `EXPIRY` tiers as the single source of truth for default
  delegation lifetimes. Pick a tier, not a number, when adding a new
  delegation surface.

  The delegation tiers and signed URL TTL, exported from `@tinycloud/sdk-core`:
  - `EXPIRY.EPHEMERAL_MS` (1h) — auto-refreshable, never user-visible.
  - `EXPIRY.SIGNED_READ_URL_MS` (5m) — short-lived bearer KV read URLs.
  - `EXPIRY.SESSION_MS` (7d) — sign-in sessions and runtime grants
    (capped by session anyway).
  - `EXPIRY.SHARE_MS` (7d) — share links and ad-hoc third-party
    delegations.
  - `EXPIRY.APP_MS` (30d) — manifest-declared installs.
  - `EXPIRY.MAX_MS` (10y) — caller-supplied upper bound.

  Behavior changes:
  - **`SharingService` share-link default: 24h → 7d.** Same direction as
    the runtime-grant default that already shipped at 7d. Callers passing
    explicit expiry are unaffected.
  - **`DelegationManager.create()` default: 24h → 7d** when the caller
    omits `expiry`.
  - **`SpaceService` server-response fallback: 24h → 7d** when the
    server's delegation response lacks an `expiry` field.
  - **`NodeUserAuthorization.sessionExpirationMs` default: 1h → 7d.**
    Fixes a silent inconsistency where direct `NodeUserAuthorization`
    consumers got 1h while `TinyCloudNode` users got 7d.
  - **`TinyCloudNode` public-space sub-delegation: 1h** (unchanged value,
    re-tagged as `EPHEMERAL` to make the intent legible — these are
    re-derived transparently on every public-space touch).

  Sites unchanged in value but re-pointed at tiered constants:
  - `TinyCloudNode.DEFAULT_SESSION_EXPIRATION_MS` → `EXPIRY.SESSION_MS`
  - `delegateToHelpers.DEFAULT_DELEGATION_EXPIRY_MS` → `EXPIRY.SESSION_MS`
  - `manifest.DEFAULT_EXPIRY` (`"30d"`) — still ms-format string for
    parser compatibility, comment now points at `EXPIRY.APP_MS`.

- 2305a65: Add TinyCloud location registry helpers for signed DID location records, multiaddr URL conversion, and priority-based cloud location resolution across explicit, blockchain, centralized registry, and fallback sources.
- 6561589: Add manifest v1 composition helpers, per-space capability requests, materialized manifest delegations, and the default account-space application registry grant.
- 35212bb: Add canonical scoped secret support. Manifest `secrets` entries now accept object specs with `scope` and optional `name`, and `tc.secrets` supports scoped `get`, `put`, `delete`, and `list` calls using the canonical `secrets/scoped/<scope>/<NAME>` vault layout.
- 46f126a: Add manifest `secrets` declarations and SDK helpers backed by the secrets space vault, including read-default permissions and write/delete escalation.
- f43143d: TC-1372: add `kv.createSignedReadUrl()` for minting short-lived signed KV read URLs through tinycloud-node's `/signed/kv` endpoint.

  The method signs a normal `tinycloud.kv/get` invocation for the resolved key path, posts the signed URL request to tinycloud-node, and returns an absolute URL plus the opaque ticket id and expiry metadata. Requires tinycloud-node with the TC-1368 signed KV URL API.

  The default signed read URL expiry is defined in `sdk-core` as
  `EXPIRY.SIGNED_READ_URL_MS` and exposed as
  `DEFAULT_SIGNED_READ_URL_EXPIRY_MS`.

- 78ef7eb: Add `tinycloud.vault` as an SDK permission shorthand that expands to the backing KV permissions used by encrypted vault operations, including runtime permission escalation.

### Patch Changes

- b9a24b5: Add implicit space-level `tinycloud.capabilities/read` grants for every space touched by a manifest request.
- de4d662: Expose and preserve optional manifest permission descriptions in resolved capability metadata.
- Updated dependencies [35212bb]
- Updated dependencies [46f126a]
- Updated dependencies [f43143d]
- Updated dependencies [976b3c7]
  - @tinycloud/sdk-services@2.2.0

## 2.2.0-beta.13

### Patch Changes

- Updated dependencies [976b3c7]
  - @tinycloud/sdk-services@2.2.0-beta.13

## 2.2.0-beta.12

### Minor Changes

- f43143d: TC-1372: add `kv.createSignedReadUrl()` for minting short-lived signed KV read URLs through tinycloud-node's `/signed/kv` endpoint.

  The method signs a normal `tinycloud.kv/get` invocation for the resolved key path, posts the signed URL request to tinycloud-node, and returns an absolute URL plus the opaque ticket id and expiry metadata. Requires tinycloud-node with the TC-1368 signed KV URL API.

  The default signed read URL expiry is defined in `sdk-core` as
  `EXPIRY.SIGNED_READ_URL_MS` and exposed as
  `DEFAULT_SIGNED_READ_URL_EXPIRY_MS`.

### Patch Changes

- Updated dependencies [f43143d]
  - @tinycloud/sdk-services@2.2.0-beta.12

## 2.2.0-beta.11

### Minor Changes

- 9ff4b34: Introduce `EXPIRY` tiers as the single source of truth for default
  delegation lifetimes. Pick a tier, not a number, when adding a new
  delegation surface.

  The five tiers, exported from `@tinycloud/sdk-core`:
  - `EXPIRY.EPHEMERAL_MS` (1h) — auto-refreshable, never user-visible.
  - `EXPIRY.SESSION_MS` (7d) — sign-in sessions and runtime grants
    (capped by session anyway).
  - `EXPIRY.SHARE_MS` (7d) — share links and ad-hoc third-party
    delegations.
  - `EXPIRY.APP_MS` (30d) — manifest-declared installs.
  - `EXPIRY.MAX_MS` (10y) — caller-supplied upper bound.

  Behavior changes:
  - **`SharingService` share-link default: 24h → 7d.** Same direction as
    the runtime-grant default that already shipped at 7d. Callers passing
    explicit expiry are unaffected.
  - **`DelegationManager.create()` default: 24h → 7d** when the caller
    omits `expiry`.
  - **`SpaceService` server-response fallback: 24h → 7d** when the
    server's delegation response lacks an `expiry` field.
  - **`NodeUserAuthorization.sessionExpirationMs` default: 1h → 7d.**
    Fixes a silent inconsistency where direct `NodeUserAuthorization`
    consumers got 1h while `TinyCloudNode` users got 7d.
  - **`TinyCloudNode` public-space sub-delegation: 1h** (unchanged value,
    re-tagged as `EPHEMERAL` to make the intent legible — these are
    re-derived transparently on every public-space touch).

  Sites unchanged in value but re-pointed at tiered constants:
  - `TinyCloudNode.DEFAULT_SESSION_EXPIRATION_MS` → `EXPIRY.SESSION_MS`
  - `delegateToHelpers.DEFAULT_DELEGATION_EXPIRY_MS` → `EXPIRY.SESSION_MS`
  - `manifest.DEFAULT_EXPIRY` (`"30d"`) — still ms-format string for
    parser compatibility, comment now points at `EXPIRY.APP_MS`.

## 2.2.0-beta.10

### Minor Changes

- 35212bb: Add canonical scoped secret support. Manifest `secrets` entries now accept object specs with `scope` and optional `name`, and `tc.secrets` supports scoped `get`, `put`, `delete`, and `list` calls using the canonical `secrets/scoped/<scope>/<NAME>` vault layout.

### Patch Changes

- Updated dependencies [35212bb]
  - @tinycloud/sdk-services@2.2.0-beta.10

## 2.2.0-beta.9

### Minor Changes

- 78ef7eb: Add `tinycloud.vault` as an SDK permission shorthand that expands to the backing KV permissions used by encrypted vault operations, including runtime permission escalation.

## 2.2.0-beta.7

### Minor Changes

- 46f126a: Add manifest `secrets` declarations and SDK helpers backed by the secrets space vault, including read-default permissions and write/delete escalation.

### Patch Changes

- Updated dependencies [46f126a]
  - @tinycloud/sdk-services@2.2.0-beta.7

## 2.2.0-beta.6

### Patch Changes

- b9a24b5: Add implicit space-level `tinycloud.capabilities/read` grants for every space touched by a manifest request.

## 2.2.0-beta.4

### Minor Changes

- 0401ff8: Add default TinyCloud host discovery and run it from sign-in when no explicit host is configured.

## 2.2.0-beta.3

### Minor Changes

- 2305a65: Add TinyCloud location registry helpers for signed DID location records, multiaddr URL conversion, and priority-based cloud location resolution across explicit, blockchain, centralized registry, and fallback sources.

## 2.2.0-beta.1

### Patch Changes

- de4d662: Expose and preserve optional manifest permission descriptions in resolved capability metadata.

## 2.2.0-beta.0

### Minor Changes

- 6561589: Add manifest v1 composition helpers, per-space capability requests, materialized manifest delegations, and the default account-space application registry grant.

## 2.1.0

### Minor Changes

- 8abfb4e: Bump past stale `2.1.0-beta.0` / `1.7.2-beta.0` ghost versions to publish PR #184's capability-chain delegation code.

  The earlier `2.1.0-beta.0` (TS SDKs) and `1.7.2-beta.0` (WASM) tarballs on npm predate PR #184 and are missing `resolveManifest`, `isCapabilitySubset`, manifest types, and the `parseRecapFromSiwe` re-export. This empty changeset forces `changeset version` to land on the next beta counter so the Beta Release workflow actually publishes the post-#184 code.

  All four TS packages in the linked group are named explicitly so `@tinycloud/sdk-services` advances too (naming only `@tinycloud/sdk-core` left it pinned at the ghost `2.1.0-beta.0`). Both WASM wrappers take a patch bump so the TS SDKs don't pin a stale `@tinycloud/*-sdk-wasm@1.7.2-beta.0`.

- b55ffbd: Add manifest and capability-chain primitives to `@tinycloud/sdk-core`, and re-export `parseRecapFromSiwe` from both WASM wrappers.
  - `@tinycloud/sdk-core` gains `Manifest`, `PermissionEntry`, `ResolvedCapabilities`, `resolveManifest`, `parseExpiry`, `expandActionShortNames`, default-tier constants, `isCapabilitySubset`, `parseRecapCapabilities`, `PermissionNotInManifestError`, and `SessionExpiredError`. These are the building blocks for the `delegateTo` / `requestPermissions` flow that will follow in `@tinycloud/node-sdk` and `@tinycloud/web-sdk`.
  - `@tinycloud/node-sdk-wasm` and `@tinycloud/web-sdk-wasm` re-export `parseRecapFromSiwe`, the new WASM export in `tinycloud-node` that decodes recap capabilities from a signed SIWE message.
  - The Rust rev in `packages/sdk-rs/Cargo.toml` is bumped to the commit that introduced `parseRecapFromSiwe`.
  - New `ms` dependency on `@tinycloud/sdk-core` for duration parsing.

- 9dad135: Wire manifest-driven `signIn` and multi-resource `delegateTo` end-to-end (closes the two gaps in `2.1.0-beta.1`).

  `signIn` now reads `config.manifest` and resolves it (via `resolveManifest` + the new `manifestAbilitiesUnion`) into the WASM `abilities` map used by `prepareSession`. The resulting SIWE recap covers the union of the app's own permissions AND every manifest-declared delegation's permissions, so the session key acquires coverage for both runtime use and downstream sub-delegations in one wallet prompt. Apps that don't pass a manifest fall back to `defaultActions` (legacy behaviour, no change).

  `delegateTo(did, permissions)` no longer rejects multi-entry input. The SDK now folds every `(service, path, actions)` entry into a single multi-resource abilities map and calls the WASM `createDelegation` once — producing ONE signed UCAN whose `attenuation` carries every grant. The returned `PortableDelegation` has the new optional `resources?: DelegatedResource[]` field listing the full breakdown; the legacy flat `path` + `actions` fields mirror the first (sorted) resource for back-compat.

  Listen-style apps that needed to delegate KV + SQL on the same prefix to a backend can now do so in a single `tcw.delegateTo(backendDID, [...])` call with no wallet prompt.

  **Breaking changes** — pre-2.1.0-beta.2 callers will need to update:
  - `@tinycloud/sdk-core`: `CreateDelegationWasmParams` swaps `path: string; actions: string[]` for `abilities: Record<string, Record<string, string[]>>`. `CreateDelegationWasmResult` swaps the flat `path` + `actions` for `resources: DelegatedResource[]`. New exports: `DelegatedResource`, `AbilitiesMap`, `manifestAbilitiesUnion`, `resourceCapabilitiesToAbilitiesMap`.
  - `@tinycloud/node-sdk`: `TinyCloudNodeConfig` gains an optional `manifest?: Manifest` field. `TinyCloudNode` gains `setManifest(manifest)` and `manifest` getter passthroughs to the underlying auth handler. `delegateTo` no longer throws on multi-entry input — apps that relied on that behaviour for validation must add their own length check. `PortableDelegation` gains an optional `resources?: DelegatedResource[]` field.
  - `@tinycloud/web-sdk`: `TinyCloudWeb.setManifest()` now forwards the new manifest into the underlying `TinyCloudNode` so the next `signIn()` picks it up. `BrowserWasmBindings.createDelegation` signature aligned with the new WASM ABI.
  - `@tinycloud/node-sdk-wasm` / `@tinycloud/web-sdk-wasm`: the `createDelegation` WASM export takes `abilities: object` (multi-resource map) instead of `path: string, actions: string[]`. The Rust rev in `packages/sdk-rs/Cargo.toml` is bumped to the merge commit of the `feat/create-delegation-multi-resource` PR in `tinycloud-node`.

- 61c031d: Add write-hooks support across the JS SDK surface for SDK services, core, Node, and web packages.

### Patch Changes

- 303a8eb: Add an optional per-call `nonce` override to `signIn()` while preserving constructor-level `siweConfig.nonce` support.
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

- fb1d3fd: Trigger republish after CI auth fix — nonce passthrough fix shipped in prior beta was not published to npm due to broken publish step.
- Updated dependencies [8abfb4e]
- Updated dependencies [b88728a]
- Updated dependencies [c586568]
- Updated dependencies [61c031d]
  - @tinycloud/sdk-services@2.1.0

## 2.1.0-beta.5

### Patch Changes

- 303a8eb: Add an optional per-call `nonce` override to `signIn()` while preserving constructor-level `siweConfig.nonce` support.

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

- Updated dependencies [c586568]
  - @tinycloud/sdk-services@2.1.0-beta.4

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

- Updated dependencies [b88728a]
  - @tinycloud/sdk-services@2.1.0-beta.3

## 2.1.0-beta.2

### Minor Changes

- 9dad135: Wire manifest-driven `signIn` and multi-resource `delegateTo` end-to-end (closes the two gaps in `2.1.0-beta.1`).

  `signIn` now reads `config.manifest` and resolves it (via `resolveManifest` + the new `manifestAbilitiesUnion`) into the WASM `abilities` map used by `prepareSession`. The resulting SIWE recap covers the union of the app's own permissions AND every manifest-declared delegation's permissions, so the session key acquires coverage for both runtime use and downstream sub-delegations in one wallet prompt. Apps that don't pass a manifest fall back to `defaultActions` (legacy behaviour, no change).

  `delegateTo(did, permissions)` no longer rejects multi-entry input. The SDK now folds every `(service, path, actions)` entry into a single multi-resource abilities map and calls the WASM `createDelegation` once — producing ONE signed UCAN whose `attenuation` carries every grant. The returned `PortableDelegation` has the new optional `resources?: DelegatedResource[]` field listing the full breakdown; the legacy flat `path` + `actions` fields mirror the first (sorted) resource for back-compat.

  Listen-style apps that needed to delegate KV + SQL on the same prefix to a backend can now do so in a single `tcw.delegateTo(backendDID, [...])` call with no wallet prompt.

  **Breaking changes** — pre-2.1.0-beta.2 callers will need to update:
  - `@tinycloud/sdk-core`: `CreateDelegationWasmParams` swaps `path: string; actions: string[]` for `abilities: Record<string, Record<string, string[]>>`. `CreateDelegationWasmResult` swaps the flat `path` + `actions` for `resources: DelegatedResource[]`. New exports: `DelegatedResource`, `AbilitiesMap`, `manifestAbilitiesUnion`, `resourceCapabilitiesToAbilitiesMap`.
  - `@tinycloud/node-sdk`: `TinyCloudNodeConfig` gains an optional `manifest?: Manifest` field. `TinyCloudNode` gains `setManifest(manifest)` and `manifest` getter passthroughs to the underlying auth handler. `delegateTo` no longer throws on multi-entry input — apps that relied on that behaviour for validation must add their own length check. `PortableDelegation` gains an optional `resources?: DelegatedResource[]` field.
  - `@tinycloud/web-sdk`: `TinyCloudWeb.setManifest()` now forwards the new manifest into the underlying `TinyCloudNode` so the next `signIn()` picks it up. `BrowserWasmBindings.createDelegation` signature aligned with the new WASM ABI.
  - `@tinycloud/node-sdk-wasm` / `@tinycloud/web-sdk-wasm`: the `createDelegation` WASM export takes `abilities: object` (multi-resource map) instead of `path: string, actions: string[]`. The Rust rev in `packages/sdk-rs/Cargo.toml` is bumped to the merge commit of the `feat/create-delegation-multi-resource` PR in `tinycloud-node`.

## 2.1.0-beta.1

### Minor Changes

- 8abfb4e: Bump past stale `2.1.0-beta.0` / `1.7.2-beta.0` ghost versions to publish PR #184's capability-chain delegation code.

  The earlier `2.1.0-beta.0` (TS SDKs) and `1.7.2-beta.0` (WASM) tarballs on npm predate PR #184 and are missing `resolveManifest`, `isCapabilitySubset`, manifest types, and the `parseRecapFromSiwe` re-export. This empty changeset forces `changeset version` to land on the next beta counter so the Beta Release workflow actually publishes the post-#184 code.

  All four TS packages in the linked group are named explicitly so `@tinycloud/sdk-services` advances too (naming only `@tinycloud/sdk-core` left it pinned at the ghost `2.1.0-beta.0`). Both WASM wrappers take a patch bump so the TS SDKs don't pin a stale `@tinycloud/*-sdk-wasm@1.7.2-beta.0`.

### Patch Changes

- Updated dependencies [8abfb4e]
  - @tinycloud/sdk-services@2.1.0-beta.1

## 2.1.0-beta.0

### Minor Changes

- b55ffbd: Add manifest and capability-chain primitives to `@tinycloud/sdk-core`, and re-export `parseRecapFromSiwe` from both WASM wrappers.
  - `@tinycloud/sdk-core` gains `Manifest`, `PermissionEntry`, `ResolvedCapabilities`, `resolveManifest`, `parseExpiry`, `expandActionShortNames`, default-tier constants, `isCapabilitySubset`, `parseRecapCapabilities`, `PermissionNotInManifestError`, and `SessionExpiredError`. These are the building blocks for the `delegateTo` / `requestPermissions` flow that will follow in `@tinycloud/node-sdk` and `@tinycloud/web-sdk`.
  - `@tinycloud/node-sdk-wasm` and `@tinycloud/web-sdk-wasm` re-export `parseRecapFromSiwe`, the new WASM export in `tinycloud-node` that decodes recap capabilities from a signed SIWE message.
  - The Rust rev in `packages/sdk-rs/Cargo.toml` is bumped to the commit that introduced `parseRecapFromSiwe`.
  - New `ms` dependency on `@tinycloud/sdk-core` for duration parsing.

- 61c031d: Add write-hooks support across the JS SDK surface for SDK services, core, Node, and web packages.

### Patch Changes

- Updated dependencies [61c031d]
  - @tinycloud/sdk-services@2.1.0-beta.0

## 2.0.4-beta.0

### Patch Changes

- fb1d3fd: Trigger republish after CI auth fix — nonce passthrough fix shipped in prior beta was not published to npm due to broken publish step.

## 2.0.3

### Patch Changes

- c2f2d54: Upgrade siwe from v2 to v3 (rewritten ABNF parser, removed deprecated validate method)
- e422647: Add top-level `nonce` field to `ClientConfig` / `TinyCloudNodeConfig` and ship the WASM rev bump carrying the SIWE nonce passthrough fix from tinycloud-node.
  - **WASM rev bump (previously merged without a changeset)**: `@tinycloud/sdk-rs` now tracks a tinycloud-node revision that accepts `nonce` in `SessionConfig`. Before this rev, `siweConfig.nonce` was forwarded by the TypeScript layer but silently dropped inside the Rust WASM layer. Single-signature auth flows that rely on server-provided nonces (e.g. billing sidecars) now work end-to-end.
  - **New top-level `nonce` field**: Callers can now pass `nonce` directly on `ClientConfig` / `TinyCloudNodeConfig` instead of nesting it under `siweConfig`. Precedence is `siweConfig.nonce` > top-level `nonce` > random (generated by the WASM layer), so `siweConfig.nonce` still wins when both are set. Omitting both preserves existing behavior.
  - @tinycloud/sdk-services@2.0.3

## 2.0.3-beta.3

### Patch Changes

- e422647: Add top-level `nonce` field to `ClientConfig` / `TinyCloudNodeConfig` and ship the WASM rev bump carrying the SIWE nonce passthrough fix from tinycloud-node.
  - **WASM rev bump (previously merged without a changeset)**: `@tinycloud/sdk-rs` now tracks a tinycloud-node revision that accepts `nonce` in `SessionConfig`. Before this rev, `siweConfig.nonce` was forwarded by the TypeScript layer but silently dropped inside the Rust WASM layer. Single-signature auth flows that rely on server-provided nonces (e.g. billing sidecars) now work end-to-end.
  - **New top-level `nonce` field**: Callers can now pass `nonce` directly on `ClientConfig` / `TinyCloudNodeConfig` instead of nesting it under `siweConfig`. Precedence is `siweConfig.nonce` > top-level `nonce` > random (generated by the WASM layer), so `siweConfig.nonce` still wins when both are set. Omitting both preserves existing behavior.

## 2.0.3-beta.2

### Patch Changes

- c2f2d54: Upgrade siwe from v2 to v3 (rewritten ABNF parser, removed deprecated validate method)

## 2.0.2

### Patch Changes

- 7bb188f: Fix ESM compatibility by migrating sdk-core and sdk-services from tsc to tsup. Resolves extensionless import errors in Node's strict ESM resolver (e.g. Next.js instrumentation hooks).
- Updated dependencies [7bb188f]
  - @tinycloud/sdk-services@2.0.2

## 2.0.1

### Patch Changes

- Updated dependencies [75690db]
  - @tinycloud/sdk-services@2.0.1

## 2.0.0

### Minor Changes

- 6eebc29: Unify web-sdk and node-sdk: TinyCloudWeb is now a thin wrapper around TinyCloudNode.

  Breaking changes (web-sdk):
  - `@tinycloud/web-core` package deleted — import types from `@tinycloud/sdk-core` or `@tinycloud/web-sdk`
  - `WebUserAuthorization` class removed — use `tcw.session()`, `tcw.did`, `tcw.address()` instead
  - `tcw.webAuth` and `tcw.userAuthorization` accessors removed
  - `WebSignStrategy` / `WalletPopupStrategy` types removed

  New in node-sdk:
  - `signer`, `wasmBindings`, `notificationHandler`, `ensResolver`, `spaceCreationHandler` config options
  - `connectSigner()` method for injecting any ISigner
  - `@tinycloud/node-sdk/core` entry point (zero Node WASM deps, for browser bundlers)
  - `restoreSession()` now initializes Vault

  New in sdk-core:
  - `INotificationHandler`, `IENSResolver`, `IWasmBindings`, `ISessionManager` interfaces
  - `ClientSession`, `SiweConfig`, `EnsData` types (moved from web-core)

  New in web-sdk:
  - `sql`, `duckdb` services now available
  - Browser adapters: `BrowserWalletSigner`, `BrowserSessionStorage`, `BrowserNotificationHandler`, `BrowserWasmBindings`, `BrowserENSResolver`
  - ENS name resolution in delegation methods

## 1.7.0

### Patch Changes

- Updated dependencies [8649de8]
- Updated dependencies [8649de8]
- Updated dependencies [def099d]
  - @tinycloud/sdk-services@1.7.0
  - @tinycloud/web-core@1.7.0

## 1.6.0

### Minor Changes

- db50ae4: Add DuckDB service to the TypeScript SDK. Provides `tc.duckdb` for querying and managing DuckDB databases on TinyCloud nodes, including `query()`, `queryArrow()`, `execute()`, `batch()`, `describe()`, `export()`, and `import()` operations. Named database handles via `tc.duckdb.database()`. SDK services are now conditionally initialized based on node feature detection — accessing an unsupported service throws `UnsupportedFeatureError`.

### Patch Changes

- 9454b78: Add unit tests for `activateSessionWithHost` covering successful activation, old-server fallback, error responses, body read failures, and request construction.
- Updated dependencies [db50ae4]
  - @tinycloud/sdk-services@1.6.0
  - @tinycloud/web-core@1.6.0

## 1.5.0

### Patch Changes

- Updated dependencies [9d6b79f]
  - @tinycloud/sdk-services@1.5.0

## 1.3.0

### Minor Changes

- 94ad509: Add Data Vault (encrypted KV) support with WASM crypto bindings, vault service initialization in TinyCloudWeb, public space helpers, and NodeUserAuthorization improvements
- 94ad509: Add Data Vault service for client-side encrypted KV storage with X25519 key exchange and AES-256-GCM encryption
- 94ad509: Add multi-space session support with enablePublicSpace config (default: true). Single signIn covers both primary and public space. Fix space-scoped KV factory to properly scope to target space.
- 94ad509: Add public space support for discoverable, unauthenticated data publishing
  - `makePublicSpaceId(address, chainId)` utility for deterministic public space ID construction
  - `TinyCloud.ensurePublicSpace()` creates the user's public space on first need
  - `TinyCloud.publicKV` getter returns IKVService scoped to the user's public space
  - `TinyCloud.readPublicSpace(host, spaceId, key)` static method for unauthenticated reads
  - `TinyCloud.readPublicKey(host, address, chainId, key)` static convenience method

- 94ad509: Register DataVaultService in TinyCloudNode with WASM crypto bindings and rewrite vault demo to use SDK

### Patch Changes

- Updated dependencies [94ad509]
  - @tinycloud/sdk-services@1.3.0

## 1.2.0

### Minor Changes

- bcbebbe: Add public space support for discoverable, unauthenticated data publishing
  - `makePublicSpaceId(address, chainId)` utility for deterministic public space ID construction
  - `TinyCloud.ensurePublicSpace()` creates the user's public space on first need
  - `TinyCloud.publicKV` getter returns IKVService scoped to the user's public space
  - `TinyCloud.readPublicSpace(host, spaceId, key)` static method for unauthenticated reads
  - `TinyCloud.readPublicKey(host, address, chainId, key)` static convenience method

- ca9b2c6: Add SQL service (tinycloud.sql/\*) with full TypeScript SDK support
  - New SQLService in sdk-services: query, execute, batch, executeStatement, export
  - DatabaseHandle for per-database operations
  - SQL re-exports in sdk-core with TinyCloud.sql getter
  - Node-SDK: SQL wiring in TinyCloudNode, DelegatedAccess, root delegation defaults
  - Fix type-only re-exports preventing bun runtime resolution

### Patch Changes

- Updated dependencies [ca9b2c6]
  - @tinycloud/sdk-services@1.2.0

## 1.1.0

### Minor Changes

- 855e0d9: Remove legacy code for v1 cleanup
  - Remove deprecated `onSessionExtensionNeeded` callback from SharingService (use `onRootDelegationNeeded` instead)
  - Remove deprecated `extendSessionForSharing()` method from TinyCloudWeb
  - Remove legacy `delegationCid` share link format support (only `cid` is supported)
  - Remove legacy fallback in `getSessionExpiry()`
  - Remove unused `express` and `express-session` dependencies from web-core

- ba988fb: feat: Add root delegation support for long-lived share links

  When creating share links with expiry longer than the current session, the SDK now creates a direct delegation from the wallet (PKH) to the share key, bypassing the session delegation chain. This allows share links to have any expiry duration regardless of session length.

  **New callback**: `onRootDelegationNeeded` in SharingServiceConfig
  - Called when share expiry exceeds session expiry
  - Receives the share key DID to delegate to
  - Returns a direct wallet-to-share-key delegation

  **Deprecated**: `onSessionExtensionNeeded` - does not solve the expiry problem as sub-delegations are still constrained by parent expiry.

  **Breaking change**: None - new callback is optional, falls back to existing behavior.

### Patch Changes

- Updated dependencies [855e0d9]
  - @tinycloud/web-core@1.1.0

## 1.0.1

### Patch Changes

- @tinycloud/web-core@1.0.1

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

### Patch Changes

- b863afb: Fix sharing link delegation bugs
  - Fix 401 Unauthorized error: Clamp sharing link expiry to session expiry to ensure child delegation expiry never exceeds parent
  - Fix "Invalid symbol 32" base64 decode error: Remove incorrect "Bearer " prefix from authHeader in sharing link data

- Updated dependencies [866981c]
  - @tinycloudlabs/web-core@1.0.0
  - @tinycloudlabs/sdk-services@1.0.0

## 0.2.0

### Minor Changes

- a2b4b66: Create sdk-core package with shared interfaces and TinyCloud class
  - ISigner: Platform-agnostic signer interface
  - ISessionStorage: Session persistence abstraction
  - IUserAuthorization: Main authorization interface
  - ITinyCloudStorage: Storage operations interface
  - TinyCloud: Unified SDK class that accepts IUserAuthorization

  This package enables code sharing between web-sdk and node-sdk while
  allowing platform-specific implementations for signing and session storage.

### Patch Changes

- @tinycloudlabs/web-core@0.3.1
