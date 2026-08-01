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
- New tests in
  `packages/sdk-core/src/authorization/openkey-protocol.test.ts::parseCanonicalRecapResource`
  cover: whole-space grant (`path` empty), path-scoped grant (short
  stripped), repeated-space grant (`path` = space), non-tinycloud URN
  passthrough, and a cross-check against real WASM `parseRecapFromSiwe`
  outputs for four representative URI shapes.

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
- New tests:
  - `NodeUserAuthorization.signInWithOpenKeyResult.test.ts` — a
    narrowed-SIWE-with-ReCap-derived-statement test proves the full
    round-trip completes (was: rejected) AND asserts the pre-condition
    that the statement genuinely differs pre/post narrowing.
  - A contrapositive test proves `diffImmutableSiweFields` still
    rejects statement drift when `originalHasRecap: false`.

What these changesets do NOT claim:
- OpenKey Hono routes are exercised directly from the js-sdk test
  suite. The matching e2e test on the OpenKey side
  (`delegate-authorize-sign-nodeauth-e2e.test.ts`) invokes the real
  Hono router with a production-shape SIWE and asserts the response
  envelope matches what `signInWithOpenKeyResult` validates. The js-sdk
  side tests the consumer via `wireOpenKeyAuthorize` against a
  simulator that mirrors the router's wire shape byte-for-byte.
- Cross-signing broadening: the strict caveat multiset equality that
  Sol required lives on the OpenKey server side (see the matching
  OpenKey changeset). The js-sdk `unauthorizedRecapCapabilities` was
  already strict — no behaviour change on this side.
