---
"@tinycloud/sdk-core": patch
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
"@tinycloud/sdk-services": patch
"@tinycloud/cli": patch
---

Address Sol continuation-review rejection blockers on the OpenKey
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
