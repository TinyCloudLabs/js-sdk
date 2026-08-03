---
"@tinycloud/sdk-core": patch
"@tinycloud/node-sdk": patch
---

Sol final-continuation-review fixes on the OpenKey authorization consumer.
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
  `packages/node-sdk/src/authorization/NodeUserAuthorization.signInWithOpenKeyResult.test.ts`:
  - `signInWithOpenKeyResult accepts a finalize body in the EXACT
    wire shape the Hono /authorize-sign route emits` builds a real
    prepared session via the SDK, signs the exact prepared SIWE
    bytes with the local signer, and assembles a finalize body byte-
    for-byte in the Hono route's response shape (`{ protocolVersion,
    address, signature, signedMessage, selectedActionKeys, permissions
    }`). Passes DIRECTLY to `signInWithOpenKeyResult` — no bridge, no
    simulator. Asserts the consumer accepts the wire body end-to-end
    and produces a client session with the correct address and
    signed bytes.
  - `signInWithOpenKeyResult accepts a NARROWED finalize body in the
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
