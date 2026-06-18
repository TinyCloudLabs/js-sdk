# @tinycloud/cli

## 0.7.0-beta.7

### Patch Changes

- Updated dependencies [7c5fe21]
  - @tinycloud/node-sdk@2.4.0-beta.5

## 0.7.0-beta.6

### Patch Changes

- e2c3bb1: Add `tc secrets doctor` and include default secrets decrypt permissions when app manifests request readable secrets.

## 0.7.0-beta.5

### Patch Changes

- Updated dependencies [8e8f7e8]
  - @tinycloud/node-sdk@2.4.0-beta.3

## 0.7.0-beta.4

### Minor Changes

- 934534d: Auth/hosting developer experience for the delegate-asks-owner-to-host model.
  - **`tc space host-request <name> --emit <file>`** (delegate-only): emits a `tinycloud.host.request` artifact naming the space and its resolved owner DID so an agent can surface it to the owner, who then runs `tc space host <name>`. If the caller IS the root authority of the resolved space, it refuses (`ALREADY_ROOT_AUTHORITY`) and tells them to host directly — no request is emitted. The command is a pure local emit and never contacts the node.
  - **Identity-aware `SPACE_NOT_HOSTED`**: an unhosted-space write/read previously surfaced as an opaque `404 - Space not found`. The kv and sql commands now normalize **only** that exact condition (404 + "Space not found" body) to a `SPACE_NOT_HOSTED` error carrying an identity-aware `hint`. The branch key `is_root_authority(space, active session)` is computed locally from the profile address + space DID (no network): the owner is told to run `tc space host <name>`, a delegate is told they cannot host and to emit `tc space host-request <name> --emit`. A wrong db/table/path or permission error is left untouched. A `delegate-session` profile is never treated as the root authority even when its stored ownerDid is the space owner, so a delegate always gets the host-request hint. `KVService` get/head/delete now preserve the `Space not found` 404 body (previously collapsed to `KV_NOT_FOUND` before the body was read), so unhosted-space **reads** normalize too, while a genuine missing key still reports `KV_NOT_FOUND`.
  - **SDK `grantAuthRequest(authority, request, options?)`** (`@tinycloud/node-sdk`): takes a delegation request artifact and returns a grant artifact (`tinycloud.auth.delegation`) by signing through `delegateTo`, so the request→grant handshake is callable programmatically. `tc auth grant` is now a thin wrapper over it. Adds the `AuthRequestArtifact`, `AuthDelegationArtifact`, and `DelegationAuthority` types.

### Patch Changes

- Updated dependencies [934534d]
  - @tinycloud/node-sdk@2.4.0-beta.2

## 0.7.0-beta.3

### Patch Changes

- 0187e64: Fix `OPENKEY_SCOPE_MISMATCH` on `tc auth request --grant` for OpenKey profiles, and batch multiple `--cap` on one space into a single OpenKey round-trip.

  The CLI compared the space the OpenKey node returned against the space it built for the request byte-for-byte. OpenKey returns the EIP-55 **checksummed** eip155 address (`0xd559CCd9...dE93cf412`) while the CLI builds the **lowercase** form, so a grant for a valid space spuriously failed with `OPENKEY_SCOPE_MISMATCH`. Ethereum addresses are case-insensitive; space comparison now normalizes (lowercases) the address segment on both sides.

  The same normalization is applied when grouping requested caps by space, so multiple `--cap` for the same space — even if one is typed checksummed and another lowercase — batch into a single OpenKey browser round-trip instead of one per casing.

## 0.7.0-beta.2

### Minor Changes

- 0e8ccc6: Add `TinyCloudNode.hostOwnedSpace(name)` and wire `tc space create`/`tc space host` to it.

  Hosting an owned space (e.g. `applications`) by name now registers it on the server via the host-SIWE delegation flow, so subsequent KV/SQL writes to that space succeed instead of returning `404 - Space not found`. Unlike the internal `ensureOwnedSpaceHosted`, this always submits the host delegation rather than inferring hosting from session activation — a space the current session has never referenced is reported neither `activated` nor `skipped`, which previously caused the host to be silently skipped. The host SIWE is idempotent server-side, so re-hosting an existing space is a safe no-op.

  The `tc space create <name>` command (which previously POSTed the unsupported `tinycloud.space/create` action and failed with `401 Unauthorized`) now hosts the caller's owned space; `tc space host <name>` is added as an alias.

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

- Updated dependencies [0e8ccc6]
  - @tinycloud/node-sdk@2.4.0-beta.1

## 0.7.0-beta.1

### Minor Changes

- 5737b67: Add `tc secrets get <NAME> --delegation <file-or-imported-profile>` for reading a secret you were delegated access to. The `--delegation` source can be a delegation JSON file or the name of a profile that imported the delegation (resolved from `additional-delegations.json`). The read path validates that the delegation covers both the secret's `tinycloud.kv/get` path and the envelope's `tinycloud.encryption/decrypt` network, then activates the delegation in wallet mode via `node.useDelegation(...)` to fetch and decrypt the value. Adds a `smoke:delegated-secrets` script that exercises the full owner-delegate flow against a live node.

### Patch Changes

- 5737b67: Fix `tc auth import` rejecting cross-user delegations. Import unconditionally called `node.useRuntimeDelegation(...)`, which requires the delegation to target the active session key and so threw `Runtime delegation targets did:pkh:... but this session key is did:key:...` for a delegation received from another user (audience = your stable identity DID). Import now routes by audience: a delegation that targets the active session key is still installed as a runtime grant, while a cross-user delegation is persisted to `additional-delegations.json` and later activated at read time via `node.useDelegation(...)`. The `imported` output now includes an `activated` flag indicating whether a runtime grant was installed.

## 0.6.1-beta.0

### Patch Changes

- Updated dependencies [b6c3fd8]
  - @tinycloud/node-sdk@2.3.1-beta.0

## 0.6.0

### Minor Changes

- 9550c18: Add CLI auth artifact handoff flows for owner/delegate workflows.

  `tc auth request` now emits and stores a `tinycloud.auth.request` artifact by
  default, with `--grant` preserving the immediate grant behavior. Profiles now
  track canonical posture/operator metadata so a local key, OpenKey owner, or
  delegate session can be represented explicitly.

  New commands:
  - `tc auth grant <request>` consumes a request artifact as an owner profile and
    emits a `tinycloud.auth.delegation` artifact to stdout. Local-key owner
    grants can use `--yes` for non-interactive approval.
  - `tc auth import <artifact>` installs delegation artifacts and preserves their
    originating request id.
  - `tc auth retry <requestId|--last> --exec` reruns the captured command once the
    requested permissions are covered.

  Local-key CLI profiles now persist and restore their TinyCloud session key
  identity so request artifacts target the same session key that later imports the
  delegation. `@tinycloud/node-sdk` now accepts runtime delegations targeted at the
  fragmentless form of the current session DID (`did:key:...`) as equivalent to
  the session verification method DID URL (`did:key:...#...`).

- fb96a1e: Rename owner/delegate identity surfaces from primary/principal terminology to owner terminology.

  CLI profiles and auth request artifacts now use `ownerDid` and `sessionDid`. Encryption network descriptors and discovery APIs now expose the owner identity as `ownerDid`.

### Patch Changes

- 9ee7404: Harden encryption-network decrypt flows, add CLI secrets coverage, and fix web WASM initialization.
- a92819d: Add canonical EVM address and `did:pkh:eip155` helpers, then use them when building and comparing TinyCloud DIDs and space IDs.
- ac2dde4: Add `tc auth rotate` for rotating the active CLI profile session key and refreshing auth.
- 74161ce: Show the installed CLI version in the default `tc` help output.
- 836915f: Add `tc status` to show local profile, session, delegation, and permission state in human and JSON formats.

  TinyCloud secrets commands now request the required owner delegation and retry once when a secrets operation fails because the active session or permission grant is missing or expired.

- ddab8fa: Add `TinyCloudNode.kvForSpace(spaceId)` and a `--space` option on `tc kv get/list/head`, mirroring the existing `sqlForSpace` / `tc sql --space`. This lets KV reads target a non-primary space — e.g. reading a manifest app's data kept under the owner's `applications` space (such as Listen's transcripts at `applications/kv/<app-id>/transcript/<id>`) when the session already holds a covering delegation.
- f2d0014: Strip private JWK fields before sending delegate key material to OpenKey.
- d606baf: Accept equivalent `did:pkh:eip155` owner DID address casing when validating encryption network descriptors, including legacy `principal` descriptors, so `tc secrets` can read existing network metadata. Pin the Rust WASM source to the released `tinycloud-node` `v1.4.2` tag.
- fb1ef97: Request fully-qualified TinyCloud actions when OpenKey grants secrets permissions.
- 91f2025: Refresh expired owner OpenKey sessions before running TinyCloud secrets commands.
- Updated dependencies [9ee7404]
- Updated dependencies [a92819d]
- Updated dependencies [90bdc18]
- Updated dependencies [9550c18]
- Updated dependencies [f615a19]
- Updated dependencies [ddab8fa]
- Updated dependencies [fb96a1e]
- Updated dependencies [d606baf]
- Updated dependencies [c7676d6]
- Updated dependencies [f11e468]
  - @tinycloud/node-sdk@2.3.0
  - @tinycloud/node-sdk-wasm@1.7.4

## 0.6.0-beta.11

### Patch Changes

- ddab8fa: Add `TinyCloudNode.kvForSpace(spaceId)` and a `--space` option on `tc kv get/list/head`, mirroring the existing `sqlForSpace` / `tc sql --space`. This lets KV reads target a non-primary space — e.g. reading a manifest app's data kept under the owner's `applications` space (such as Listen's transcripts at `applications/kv/<app-id>/transcript/<id>`) when the session already holds a covering delegation.
- Updated dependencies [ddab8fa]
- Updated dependencies [f11e468]
  - @tinycloud/node-sdk@2.3.0-beta.8

## 0.6.0-beta.10

### Patch Changes

- @tinycloud/node-sdk@2.3.0-beta.7

## 0.6.0-beta.9

### Patch Changes

- ac2dde4: Add `tc auth rotate` for rotating the active CLI profile session key and refreshing auth.
- fb1ef97: Request fully-qualified TinyCloud actions when OpenKey grants secrets permissions.

## 0.6.0-beta.8

### Patch Changes

- f2d0014: Strip private JWK fields before sending delegate key material to OpenKey.

## 0.6.0-beta.7

### Patch Changes

- 836915f: Add `tc status` to show local profile, session, delegation, and permission state in human and JSON formats.

  TinyCloud secrets commands now request the required owner delegation and retry once when a secrets operation fails because the active session or permission grant is missing or expired.

- 91f2025: Refresh expired owner OpenKey sessions before running TinyCloud secrets commands.
- Updated dependencies [c7676d6]
  - @tinycloud/node-sdk@2.3.0-beta.6

## 0.6.0-beta.6

### Patch Changes

- 74161ce: Show the installed CLI version in the default `tc` help output.

## 0.6.0-beta.5

### Patch Changes

- d606baf: Accept equivalent `did:pkh:eip155` owner DID address casing when validating encryption network descriptors, including legacy `principal` descriptors, so `tc secrets` can read existing network metadata. Pin the Rust WASM source to the released `tinycloud-node` `v1.4.2` tag.
- Updated dependencies [d606baf]
  - @tinycloud/node-sdk@2.3.0-beta.5
  - @tinycloud/node-sdk-wasm@1.7.4-beta.1

## 0.6.0-beta.4

### Patch Changes

- Updated dependencies [90bdc18]
  - @tinycloud/node-sdk@2.3.0-beta.4

## 0.6.0-beta.3

### Patch Changes

- a92819d: Add canonical EVM address and `did:pkh:eip155` helpers, then use them when building and comparing TinyCloud DIDs and space IDs.
- Updated dependencies [a92819d]
  - @tinycloud/node-sdk@2.3.0-beta.3

## 0.6.0-beta.2

### Minor Changes

- fb96a1e: Rename owner/delegate identity surfaces from primary/principal terminology to owner terminology.

  CLI profiles and auth request artifacts now use `ownerDid` and `sessionDid`. Encryption network descriptors and discovery APIs now expose the owner identity as `ownerDid`.

### Patch Changes

- Updated dependencies [fb96a1e]
  - @tinycloud/node-sdk@2.3.0-beta.2

## 0.6.0-beta.1

### Minor Changes

- 9550c18: Add CLI auth artifact handoff flows for owner/delegate workflows.

  `tc auth request` now emits and stores a `tinycloud.auth.request` artifact by
  default, with `--grant` preserving the immediate grant behavior. Profiles now
  track canonical posture/operator metadata so a local key, OpenKey owner, or
  delegate session can be represented explicitly.

  New commands:
  - `tc auth grant <request>` consumes a request artifact as an owner profile and
    emits a `tinycloud.auth.delegation` artifact to stdout. Local-key owner
    grants can use `--yes` for non-interactive approval.
  - `tc auth import <artifact>` installs delegation artifacts and preserves their
    originating request id.
  - `tc auth retry <requestId|--last> --exec` reruns the captured command once the
    requested permissions are covered.

  Local-key CLI profiles now persist and restore their TinyCloud session key
  identity so request artifacts target the same session key that later imports the
  delegation. `@tinycloud/node-sdk` now accepts runtime delegations targeted at the
  fragmentless form of the current session DID (`did:key:...`) as equivalent to
  the session verification method DID URL (`did:key:...#...`).

### Patch Changes

- Updated dependencies [9550c18]
  - @tinycloud/node-sdk@2.2.1-beta.1

## 0.5.1-beta.0

### Patch Changes

- 9ee7404: Harden encryption-network decrypt flows, add CLI secrets coverage, and fix web WASM initialization.
- Updated dependencies [9ee7404]
- Updated dependencies [f615a19]
  - @tinycloud/node-sdk@2.2.1-beta.0
  - @tinycloud/node-sdk-wasm@1.7.4-beta.0

## 0.5.0

### Minor Changes

- 9ff4b34: CLI: agent-friendly permission management and cross-space SQL.
  - `tc auth request` requests additional runtime permissions via the SDK's
    `grantRuntimePermissions` flow. Accepts `--cap <spec>`, `--permission <file>`,
    or `--manifest <fileOrBase64>`. OpenKey path forwards the requested entries
    through the `/delegate` URL so the consent UI shows what's being asked for.
  - `tc auth caps` lists appended runtime delegations and their granted
    capabilities. `--diff <spec>` reports whether the active session covers a
    capability without granting it. `--history` shows the audit log.
  - `tc manifest resolve <fileOrUrl>` is a read-only diagnostic that prints the
    effective space URI, capability paths, and SQL database basenames for an
    app manifest.
  - `tc sql query|execute|export --space <name|uri>` routes through a
    per-space SQL service so non-primary-space data is reachable. Backed by a
    new `TinyCloudNode.sqlForSpace(spaceId)` helper that mirrors the per-space
    KV factory pattern.
  - `tc sql copy --from-space S --from-db D --to-space S2 --to-db D2 [--table T...] [--dry-run]`
    copies rows between databases (optionally across spaces). Refuses self-copy.
  - AUTH_UNAUTHORIZED errors emit a copy-pasteable
    `tc auth request --cap "..."` hint derived from the unauthorized resource
    and required action.
  - NETWORK_ERROR emits a hint listing alternate profiles and their hosts when
    the active profile's host is unreachable.
  - `ProfileConfig.openkeyHost` (or `TC_OPENKEY_HOST` env var) overrides the
    OpenKey base URL per profile, enabling self-hosted or local OpenKey
    deployments for testing accounts. Default unchanged.
  - Persists appended runtime delegations alongside the existing session in
    `~/.tinycloud/profiles/<p>/additional-delegations.json` and replays them
    via `useRuntimeDelegation()` on next CLI invocation. Grants logged to
    `auth-grants.jsonl`.

  node-sdk: adds `TinyCloudNode.sqlForSpace(spaceId): ISQLService` so callers
  that already hold a delegation covering a non-primary space can issue SQL
  queries without restoring a fresh session.

- 9ff4b34: Default delegation lifetime bumped to 7 days; default session lifetime
  bumped to 7 days; CLI gains `tc auth request --expiry`.

  Why: 1-hour grants forced agent workflows to re-prompt the user for caps
  they had already approved on every CLI invocation past the first hour.
  The session itself defaulted to 1 hour too, so even an explicit
  `--expiry 30d` couldn't outlive its parent. Both defaults moved to 7
  days so the common agent loop runs unattended for a week.
  - `delegateToHelpers.resolveExpiryMs(undefined)` now returns
    `DEFAULT_DELEGATION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000`.
  - `TinyCloudNodeConfig.sessionExpirationMs` default is now
    `DEFAULT_SESSION_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000`. Existing
    callers passing an explicit value are unaffected. Wallet-mode SIWE
    sessions cap at 1 hour by protocol — that limit is independent of
    this default.
  - `tc auth request --expiry <duration>` accepts a ms-format string
    (`"7d"`, `"30m"`) or raw millisecond integer. Forwarded to
    `node.grantRuntimePermissions(permissions, { expiry })` for the
    local-key path and encoded into the OpenKey `/delegate?expiry=...`
    URL parameter for the OpenKey path. OpenKey-side support landed
    separately in TinyCloudLabs/openkey.

### Patch Changes

- 010ee0f: Fix `restoreSession` so runtime-permission-grant operations work after
  session restore (notably the OpenKey-backed CLI path).

  `TinyCloudNode.restoreSession` populated `_serviceContext.session` (the
  `ServiceSession` used by service invokers) but never set
  `auth.tinyCloudSession` (the richer `TinyCloudSession` that surfaces the
  SIWE recap, address, chain, etc.). Methods that read from the latter —
  `hasRuntimePermissions`, `getRuntimePermissionDelegations`,
  `useRuntimeDelegation`, `grantRuntimePermissions` — therefore threw
  `SessionExpiredError(new Date(0))` immediately after every restore.

  Symptoms:
  - `tc auth request --cap …` fails with `Session expired at 1970-01-01T00:00:00.000Z`
  - Persisted runtime delegations replayed via `useRuntimeDelegation` are
    rejected, so `tc auth caps` reports `granted: []` even when
    `additional-delegations.json` has live entries.

  Changes:
  - `restoreSession` now accepts optional `siwe` and `signature` fields.
  - When `siwe` + `address` + `chainId` are provided, a full
    `TinyCloudSession` is rehydrated. In wallet mode it lands on
    `auth.tinyCloudSession` via the new
    `NodeUserAuthorization.setRestoredTinyCloudSession`. In session-only
    mode (no auth layer — typical for OpenKey-restored CLIs) it lands on
    a new `TinyCloudNode._restoredTcSession` field.
  - A new private `currentTinyCloudSession()` helper resolves the active
    session from either surface. The four runtime-permission readers
    (`hasRuntimePermissions`, `getRuntimePermissionDelegations`,
    `useRuntimeDelegation`, `grantRuntimePermissions`) now consult it.

  CLI side (`@tinycloud/cli`): `replayAdditionalDelegations` exposes a
  `TC_DEBUG_REPLAY=1` env switch that prints which stored delegations
  fail to install and why. Useful for diagnosing future restore-related
  issues.

  Backwards compatible: `restoreSession`'s new parameters are optional;
  old callers continue to work, they just don't get runtime-grant
  support until they pass `siwe`. The CLI was already passing `siwe` —
  the SDK was just dropping it.

- Updated dependencies [9ab4644]
- Updated dependencies [9ff4b34]
- Updated dependencies [0401ff8]
- Updated dependencies [04a0d5c]
- Updated dependencies [0e049d7]
- Updated dependencies [9dc2e8c]
- Updated dependencies [9ff4b34]
- Updated dependencies [9ff4b34]
- Updated dependencies [b9a24b5]
- Updated dependencies [6561589]
- Updated dependencies [010ee0f]
- Updated dependencies [8367cef]
- Updated dependencies [35212bb]
- Updated dependencies [46f126a]
- Updated dependencies [f43143d]
- Updated dependencies [78ef7eb]
  - @tinycloud/node-sdk@2.2.0
  - @tinycloud/node-sdk-wasm@1.7.3

## 0.5.0-beta.13

### Patch Changes

- @tinycloud/node-sdk@2.2.0-beta.13

## 0.5.0-beta.12

### Patch Changes

- 010ee0f: Fix `restoreSession` so runtime-permission-grant operations work after
  session restore (notably the OpenKey-backed CLI path).

  `TinyCloudNode.restoreSession` populated `_serviceContext.session` (the
  `ServiceSession` used by service invokers) but never set
  `auth.tinyCloudSession` (the richer `TinyCloudSession` that surfaces the
  SIWE recap, address, chain, etc.). Methods that read from the latter —
  `hasRuntimePermissions`, `getRuntimePermissionDelegations`,
  `useRuntimeDelegation`, `grantRuntimePermissions` — therefore threw
  `SessionExpiredError(new Date(0))` immediately after every restore.

  Symptoms:
  - `tc auth request --cap …` fails with `Session expired at 1970-01-01T00:00:00.000Z`
  - Persisted runtime delegations replayed via `useRuntimeDelegation` are
    rejected, so `tc auth caps` reports `granted: []` even when
    `additional-delegations.json` has live entries.

  Changes:
  - `restoreSession` now accepts optional `siwe` and `signature` fields.
  - When `siwe` + `address` + `chainId` are provided, a full
    `TinyCloudSession` is rehydrated. In wallet mode it lands on
    `auth.tinyCloudSession` via the new
    `NodeUserAuthorization.setRestoredTinyCloudSession`. In session-only
    mode (no auth layer — typical for OpenKey-restored CLIs) it lands on
    a new `TinyCloudNode._restoredTcSession` field.
  - A new private `currentTinyCloudSession()` helper resolves the active
    session from either surface. The four runtime-permission readers
    (`hasRuntimePermissions`, `getRuntimePermissionDelegations`,
    `useRuntimeDelegation`, `grantRuntimePermissions`) now consult it.

  CLI side (`@tinycloud/cli`): `replayAdditionalDelegations` exposes a
  `TC_DEBUG_REPLAY=1` env switch that prints which stored delegations
  fail to install and why. Useful for diagnosing future restore-related
  issues.

  Backwards compatible: `restoreSession`'s new parameters are optional;
  old callers continue to work, they just don't get runtime-grant
  support until they pass `siwe`. The CLI was already passing `siwe` —
  the SDK was just dropping it.

- Updated dependencies [0e049d7]
- Updated dependencies [010ee0f]
- Updated dependencies [f43143d]
  - @tinycloud/node-sdk-wasm@1.7.3-beta.2
  - @tinycloud/node-sdk@2.2.0-beta.12

## 0.5.0-beta.11

### Minor Changes

- 9ff4b34: CLI: agent-friendly permission management and cross-space SQL.
  - `tc auth request` requests additional runtime permissions via the SDK's
    `grantRuntimePermissions` flow. Accepts `--cap <spec>`, `--permission <file>`,
    or `--manifest <fileOrBase64>`. OpenKey path forwards the requested entries
    through the `/delegate` URL so the consent UI shows what's being asked for.
  - `tc auth caps` lists appended runtime delegations and their granted
    capabilities. `--diff <spec>` reports whether the active session covers a
    capability without granting it. `--history` shows the audit log.
  - `tc manifest resolve <fileOrUrl>` is a read-only diagnostic that prints the
    effective space URI, capability paths, and SQL database basenames for an
    app manifest.
  - `tc sql query|execute|export --space <name|uri>` routes through a
    per-space SQL service so non-primary-space data is reachable. Backed by a
    new `TinyCloudNode.sqlForSpace(spaceId)` helper that mirrors the per-space
    KV factory pattern.
  - `tc sql copy --from-space S --from-db D --to-space S2 --to-db D2 [--table T...] [--dry-run]`
    copies rows between databases (optionally across spaces). Refuses self-copy.
  - AUTH_UNAUTHORIZED errors emit a copy-pasteable
    `tc auth request --cap "..."` hint derived from the unauthorized resource
    and required action.
  - NETWORK_ERROR emits a hint listing alternate profiles and their hosts when
    the active profile's host is unreachable.
  - `ProfileConfig.openkeyHost` (or `TC_OPENKEY_HOST` env var) overrides the
    OpenKey base URL per profile, enabling self-hosted or local OpenKey
    deployments for testing accounts. Default unchanged.
  - Persists appended runtime delegations alongside the existing session in
    `~/.tinycloud/profiles/<p>/additional-delegations.json` and replays them
    via `useRuntimeDelegation()` on next CLI invocation. Grants logged to
    `auth-grants.jsonl`.

  node-sdk: adds `TinyCloudNode.sqlForSpace(spaceId): ISQLService` so callers
  that already hold a delegation covering a non-primary space can issue SQL
  queries without restoring a fresh session.

- 9ff4b34: Default delegation lifetime bumped to 7 days; default session lifetime
  bumped to 7 days; CLI gains `tc auth request --expiry`.

  Why: 1-hour grants forced agent workflows to re-prompt the user for caps
  they had already approved on every CLI invocation past the first hour.
  The session itself defaulted to 1 hour too, so even an explicit
  `--expiry 30d` couldn't outlive its parent. Both defaults moved to 7
  days so the common agent loop runs unattended for a week.
  - `delegateToHelpers.resolveExpiryMs(undefined)` now returns
    `DEFAULT_DELEGATION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000`.
  - `TinyCloudNodeConfig.sessionExpirationMs` default is now
    `DEFAULT_SESSION_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000`. Existing
    callers passing an explicit value are unaffected. Wallet-mode SIWE
    sessions cap at 1 hour by protocol — that limit is independent of
    this default.
  - `tc auth request --expiry <duration>` accepts a ms-format string
    (`"7d"`, `"30m"`) or raw millisecond integer. Forwarded to
    `node.grantRuntimePermissions(permissions, { expiry })` for the
    local-key path and encoded into the OpenKey `/delegate?expiry=...`
    URL parameter for the OpenKey path. OpenKey-side support landed
    separately in TinyCloudLabs/openkey.

### Patch Changes

- Updated dependencies [9ff4b34]
- Updated dependencies [9ff4b34]
- Updated dependencies [9ff4b34]
  - @tinycloud/node-sdk@2.2.0-beta.11

## 0.4.8-beta.10

### Patch Changes

- Updated dependencies [35212bb]
  - @tinycloud/node-sdk@2.2.0-beta.10

## 0.4.8-beta.9

### Patch Changes

- Updated dependencies [78ef7eb]
  - @tinycloud/node-sdk@2.2.0-beta.9

## 0.4.8-beta.8

### Patch Changes

- Updated dependencies [8367cef]
  - @tinycloud/node-sdk@2.2.0-beta.8

## 0.4.8-beta.7

### Patch Changes

- Updated dependencies [46f126a]
  - @tinycloud/node-sdk@2.2.0-beta.7

## 0.4.8-beta.6

### Patch Changes

- Updated dependencies [b9a24b5]
  - @tinycloud/node-sdk@2.2.0-beta.6

## 0.4.8-beta.5

### Patch Changes

- Updated dependencies [9ab4644]
- Updated dependencies [9dc2e8c]
  - @tinycloud/node-sdk@2.2.0-beta.5
  - @tinycloud/node-sdk-wasm@1.7.3-beta.1

## 0.4.8-beta.4

### Patch Changes

- Updated dependencies [0401ff8]
  - @tinycloud/node-sdk@2.2.0-beta.4

## 0.4.8-beta.3

### Patch Changes

- @tinycloud/node-sdk@2.2.0-beta.3

## 0.4.8-beta.2

### Patch Changes

- Updated dependencies [04a0d5c]
  - @tinycloud/node-sdk@2.2.0-beta.2

## 0.4.8-beta.1

### Patch Changes

- @tinycloud/node-sdk@2.2.0-beta.1

## 0.4.8-beta.0

### Patch Changes

- Updated dependencies [6561589]
  - @tinycloud/node-sdk@2.2.0-beta.0
  - @tinycloud/node-sdk-wasm@1.7.3-beta.0

## 0.4.7

### Patch Changes

- fa130e0: Improve `tc sql` help output with SQLite workflow examples, parameter binding guidance, named database usage, and documented query/execute/export output shapes.
- Updated dependencies [303a8eb]
- Updated dependencies [8abfb4e]
- Updated dependencies [b55ffbd]
- Updated dependencies [b88728a]
- Updated dependencies [c586568]
- Updated dependencies [9dad135]
- Updated dependencies [4fac901]
- Updated dependencies [9a9fae1]
- Updated dependencies [fb1d3fd]
- Updated dependencies [61c031d]
  - @tinycloud/node-sdk@2.1.0
  - @tinycloud/node-sdk-wasm@1.7.2

## 0.4.7-beta.7

### Patch Changes

- Updated dependencies [4fac901]
  - @tinycloud/node-sdk@2.1.0-beta.6

## 0.4.7-beta.6

### Patch Changes

- fa130e0: Improve `tc sql` help output with SQLite workflow examples, parameter binding guidance, named database usage, and documented query/execute/export output shapes.

## 0.4.7-beta.5

### Patch Changes

- Updated dependencies [303a8eb]
  - @tinycloud/node-sdk@2.1.0-beta.5

## 0.4.7-beta.4

### Patch Changes

- Updated dependencies [c586568]
  - @tinycloud/node-sdk@2.1.0-beta.4

## 0.4.7-beta.3

### Patch Changes

- Updated dependencies [b88728a]
  - @tinycloud/node-sdk@2.1.0-beta.3

## 0.4.7-beta.2

### Patch Changes

- Updated dependencies [9dad135]
  - @tinycloud/node-sdk@2.1.0-beta.2
  - @tinycloud/node-sdk-wasm@1.7.2-beta.2

## 0.4.7-beta.1

### Patch Changes

- Updated dependencies [8abfb4e]
  - @tinycloud/node-sdk@2.1.0-beta.1
  - @tinycloud/node-sdk-wasm@1.7.2-beta.1

## 0.4.7-beta.0

### Patch Changes

- Updated dependencies [b55ffbd]
- Updated dependencies [9a9fae1]
- Updated dependencies [61c031d]
  - @tinycloud/node-sdk-wasm@1.7.2-beta.0
  - @tinycloud/node-sdk@2.1.0-beta.0

## 0.4.6-beta.0

### Patch Changes

- Updated dependencies [fb1d3fd]
  - @tinycloud/node-sdk@2.0.4-beta.0

## 0.4.5

### Patch Changes

- Updated dependencies [e7e6ee7]
- Updated dependencies [1379b11]
- Updated dependencies [e422647]
  - @tinycloud/node-sdk@2.0.3
  - @tinycloud/node-sdk-wasm@1.7.1

## 0.4.5-beta.2

### Patch Changes

- Updated dependencies [1379b11]
- Updated dependencies [e422647]
  - @tinycloud/node-sdk@2.0.3-beta.3

## 0.4.5-beta.1

### Patch Changes

- @tinycloud/node-sdk@2.0.3-beta.2

## 0.4.5-beta.0

### Patch Changes

- Updated dependencies [e7e6ee7]
  - @tinycloud/node-sdk@2.0.3-beta.0

## 0.4.4

### Patch Changes

- Updated dependencies [3401b3c]
  - @tinycloud/node-sdk@2.0.2

## 0.4.3

### Patch Changes

- 99219f8: Read version from package.json instead of hardcoding
  - @tinycloud/node-sdk@2.0.1

## 0.4.2

### Patch Changes

- Updated dependencies [6eebc29]
  - @tinycloud/node-sdk@2.0.0

## 0.4.1

### Patch Changes

- 3c82019: Add local Ethereum key authentication to `tc auth login`. Users can now choose between OpenKey (browser-based) and local key (Ethereum private key) auth methods. Local key auth generates a `did:pkh` identity and signs in directly without a browser, making it suitable for agents, CI/CD, and headless environments. Use `--method local` to skip the interactive prompt.

## 0.4.0

### Minor Changes

- f841493: Add `tc upgrade` command for self-updating the CLI to the latest published version. Detects the package manager used for the global install (bun or npm) and runs the appropriate upgrade command.

## 0.3.1

### Patch Changes

- Updated dependencies [8649de8]
- Updated dependencies [def099d]
  - @tinycloud/node-sdk-wasm@1.7.0
  - @tinycloud/node-sdk@1.7.0

## 0.3.0

### Minor Changes

- 153e9bb: Add `tc sql` and `tc duckdb` command groups to the CLI. SQL commands support `query`, `execute`, and `export`. DuckDB commands support `query`, `execute`, `describe`, `export`, and `import`. Both command groups accept `--db` for named databases and `--params` for bind parameters.

### Patch Changes

- Updated dependencies [db50ae4]
- Updated dependencies [bea6063]
  - @tinycloud/node-sdk@1.6.0
  - @tinycloud/node-sdk-wasm@1.6.0

## 0.2.0

### Minor Changes

- 349ae57: Add `tc secrets` and `tc vars` CLI commands for managing encrypted secrets (vault) and plaintext variables (KV) with `secrets/` and `variables/` prefixes.
- 8c08161: Updated CLI with usability improvements

### Patch Changes

- 96ce2b3: Add `tc secrets manage` command to open the Secrets Manager web UI and `--space` flag for cross-space secret listing
  - @tinycloud/node-sdk@1.5.0

## 0.1.1

### Patch Changes

- Updated dependencies [da5a499]
  - @tinycloud/node-sdk-wasm@1.4.1
  - @tinycloud/node-sdk@1.4.1

## 0.1.0

### Minor Changes

- fd25623: Add browser-based delegate auth flow for CLI login via OpenKey. The CLI opens a `/delegate` page where users authenticate with a passkey, select a key, and approve a delegation. `TinyCloudNode.restoreSession()` allows injecting stored delegation data without a private key. Also fixes `kv list` result parsing and CLI process hang after auth.

### Patch Changes

- Updated dependencies [fd25623]
  - @tinycloud/node-sdk@1.4.0

## 0.0.2

### Patch Changes

- Updated dependencies [94ad509]
- Updated dependencies [94ad509]
- Updated dependencies [94ad509]
- Updated dependencies [94ad509]
- Updated dependencies [94ad509]
  - @tinycloud/node-sdk@1.3.0

## 0.0.1

### Patch Changes

- fe83edb: Initial release
- Updated dependencies [2014a20]
- Updated dependencies [bcbebbe]
- Updated dependencies [ca9b2c6]
  - @tinycloud/node-sdk@1.2.0
