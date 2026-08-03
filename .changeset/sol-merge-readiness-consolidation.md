---
"@tinycloud/sdk-core": patch
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
"@tinycloud/sdk-services": patch
---

Merge-readiness consolidation for the OpenKey authorization protocol.

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
