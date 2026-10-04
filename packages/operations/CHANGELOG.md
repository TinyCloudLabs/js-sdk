# @tinycloud/operations

## 0.3.4-beta.5

### Patch Changes

- Updated dependencies [6484eba]
  - @tinycloud/sdk-core@3.1.0-beta.3
  - @tinycloud/node-sdk@3.1.0-beta.3

## 0.3.4-beta.4

### Patch Changes

- c923361: TC-649: For a missing secret, the setup link printed by `tc secrets get` and returned by MCP `secrets.get` now opens Secret Manager with the name filled in: `https://secrets.tinycloud.xyz/app?secret=NAME` plus `&scope=…` when scoped. Before, `https://secrets.tinycloud.xyz?name=NAME` opened the landing page and filled in nothing.

## 0.3.4-beta.3

### Patch Changes

- Updated dependencies [a074fa5]
  - @tinycloud/sdk-core@3.1.0-beta.2
  - @tinycloud/node-sdk@3.1.0-beta.2

## 0.3.4-beta.2

### Patch Changes

- Updated dependencies [0652195]
  - @tinycloud/sdk-core@3.1.0-beta.1
  - @tinycloud/node-sdk@3.1.0-beta.1

## 0.3.4-beta.1

### Patch Changes

- f25aa05: Bring the remaining profile writers under the profile lock. `tc profile delete` waits for the lock and removes the profile's files while holding it (session and key first, settings last), never another holder's lock, and unlinks a symlinked profile directory without touching its target. It refuses a name that is not one path segment with `INVALID_PROFILE_NAME`; before, `tc profile delete ..` removed the whole TinyCloud home. Local `tc auth rotate` keeps the previous session when a concurrent change refuses its commit (`PROFILE_CHANGED_DURING_LOGIN`). The delegate-session bootstrap in `tc auth import` reads the profile, key and session under the lock, never replaces a session that appeared meanwhile (`PROFILE_CHANGED_DURING_IMPORT`), and rolls itself back if it fails. A failed request-bound import rolls back that bootstrap only if the profile still holds what the bootstrap wrote, and keeps (and reports) newer state otherwise; if the rollback cannot run, the import's error is still the one reported. Other import forms keep a successful bootstrap when a later step fails, as before. A lock acquirer that finds its profile directory removed by a concurrent delete recreates it and retries within its deadline instead of failing.

## 0.3.4-beta.0

### Patch Changes

- @tinycloud/sdk-core@3.0.1-beta.0
- @tinycloud/node-sdk@3.0.1-beta.0

## 0.3.3

### Patch Changes

- 48eca36: TC-540: `tc auth login --device --manifest FILE [--expiry DUR] [--owner DID] [--replace-session]` and `tc auth request --manifest FILE --grant --device` request exactly a KV-scoped manifest's permissions through OpenKey device authorization (SQL stays on browser login). The signed SIWE ReCap is the authority: the CLI accepts an approval only when OpenKey's binding and relayed delegation state exactly the signed permissions, which must stay inside the request and match the session key, owner, origins and lifetime; `permissions`/`declined` are derived from the signed grant, and OpenKey `invalid_scope` surfaces as `SCOPE_REJECTED`. A profile that recorded an owner is pinned to it on scoped and device login (except local-owner-key profiles); device login refuses local-owner-key profiles (`LOCAL_OWNER_PROFILE`) and will not replace a live session with a different scope without `--replace-session` (`SESSION_IN_USE`). Device logins honor the profile's self-hosted `openkeyHost`, accept verification pages only on the OpenKey site, and name OpenKey when it is unreachable. Owner addresses compare case-insensitively (EIP-55 or lowercase) while chain id and space name compare exactly. `--device` requires `--manifest`; non-interactive `auth login` no longer switches to device mode or waits silently on a browser (`INTERACTIVE_LOGIN_REQUIRED`). The built-in `builtin:share-publishing` manifest requests only `tinycloud.capabilities/read` on `""` (OpenKey requires it to sign any delegation), KV get/put on `xyz.tinycloud.share/shares/` and get/metadata/put/list on `shares/`; `tc enable share` uses it.

  `--expiry` is enforced against the signed session on every login path; OpenKey `--expiry` takes durations only (ISO dates are refused up front, since OpenKey signs approval time plus a lifetime). Logins commit under the profile lock after re-reading profile, key and session: a change while approval was pending refuses with `PROFILE_CHANGED_DURING_LOGIN`, and a live session is replaced only by an approved scope that keeps all of it (`SESSION_IN_USE` otherwise, for scoped browser and device login alike). Every login keeps the profile's recorded owner and records only a signature-verified owner. Browser `--expiry` reaches OpenKey as seconds. Login commits and the `ProfileManager` profile, key and session writers take the profile lock, and read-modify-write updates hold it for the whole transaction. A failed commit write restores the pre-commit state, attempting every restore write; if restoring fails too, or interrupted state is found (including a session naming an owner the profile does not record), it surfaces as `PROFILE_STATE_INCONSISTENT`. A profile lock timeout reaching the CLI error handler is reported as `PROFILE_LOCK_TIMEOUT` with a retry hint. Signed ReCap caveats (including JSON `null` values, which the WASM verifier returns as `undefined`) are recorded with the session's permissions, and a renewal that adds a caveat to an action the live session holds unrestricted counts as narrowing (`SESSION_IN_USE`). An unscoped login whose callback carries no complete proof saves no SIWE or signature, so an unsigned expiry is never read back. Session authority fields (owner, permissions, expiry, signed-scope marker) are set only from verified proofs; `tc init` uses the same verified commit. `withProfileLock` in operations is reentrant only for the acquiring call chain and lock path while the acquisition lasts, takes the lock with an exclusive `mkdir` (the primitive older releases use) and holds it only once it has `link`ed a fully written owner record into it (`link` never replaces; EEXIST or ENOENT means not acquired, and the attempt retries), never renames anything onto the lock or its owner record, and reclaims an ownerless lock directory older than the stale threshold only by `rmdir`, so only while it is empty; claim files left by a process killed mid-recovery are removed first (never `owner.json`), and owner files a crashed acquirer staged are removed once aged. Dead-holder recovery claims the owner record with a hard link instead of moving it, so a recoverer acting on an outdated observation can no longer move a live holder's record away and restore it after that holder released (which left the lock blocked until the stale threshold); release removes its own verified record. Recovery is fenced: a recoverer that took longer than half the stale threshold between its claim and removing the dead holder's record, or a cleanup between its age check and removing claims, abandons that step (dropping only its own claim) and retries, so a recoverer paused while cleanup and a new holder moved on can never remove that holder's record. Port manifest-scoped first login (`auth login --manifest/--owner/--expiry` with signed-proof verification), the `tc context` command, and the packaged core `tc-cli` skill (SKILL, AUTH, REFERENCE, INSTALL, release.json) from the 0.10 line. The default host is now `https://tee.node.tinycloud.xyz` in the CLI, operations and MCP HTTP CLI; only an explicit `--host` is stored on a profile. Profile state is written 0600 in 0700 directories, and directories or grant history created by older releases are tightened on the next write.

  `tc share publish` authorization hints for OpenKey profiles now name `tc --profile <name> auth login --device --manifest builtin:share-publishing` (or `tc --profile <name> enable share`), and scope denials name the `builtin:share-publishing` scope; local-key profiles keep `auth login --method local`. The packaged `tc-cli` skill requires CLI `>=1.0.0-beta.17`, the first release with these commands. Device login validates that OpenKey's relay key is a P-256 point before deriving the relay secret. `tc auth request --grant --device` keeps signed ReCap caveats on the granted resources, in the stored delegation and in the reported grant, so a caveated grant is never replayed as unrestricted.

- Updated dependencies [46c83a7]
- Updated dependencies [036ce34]
- Updated dependencies [ce34dc1]
- Updated dependencies [4b60562]
- Updated dependencies [b0069f7]
- Updated dependencies [cc27c3a]
- Updated dependencies [657c1ff]
- Updated dependencies [12e5c4d]
- Updated dependencies [c690844]
- Updated dependencies [31043b5]
- Updated dependencies [b852650]
- Updated dependencies [70e6c95]
- Updated dependencies [d8b122e]
- Updated dependencies [d8b122e]
- Updated dependencies [d8b122e]
- Updated dependencies [d8b122e]
- Updated dependencies [48eca36]
- Updated dependencies [a132b77]
- Updated dependencies [2e9db6e]
- Updated dependencies [877097d]
  - @tinycloud/sdk-core@3.0.0
  - @tinycloud/node-sdk@3.0.0

## 0.3.3-beta.18

### Patch Changes

- Updated dependencies [877097d]
  - @tinycloud/node-sdk@3.0.0-beta.20

## 0.3.3-beta.17

### Patch Changes

- Updated dependencies [70e6c95]
  - @tinycloud/sdk-core@3.0.0-beta.19
  - @tinycloud/node-sdk@3.0.0-beta.19

## 0.3.3-beta.16

### Patch Changes

- Updated dependencies [a132b77]
  - @tinycloud/sdk-core@3.0.0-beta.18
  - @tinycloud/node-sdk@3.0.0-beta.18

## 0.3.3-beta.15

### Patch Changes

- @tinycloud/sdk-core@3.0.0-beta.17
- @tinycloud/node-sdk@3.0.0-beta.17

## 0.3.3-beta.14

### Patch Changes

- 48eca36: TC-540: `tc auth login --device --manifest FILE [--expiry DUR] [--owner DID] [--replace-session]` and `tc auth request --manifest FILE --grant --device` request exactly a KV-scoped manifest's permissions through OpenKey device authorization (SQL stays on browser login). The signed SIWE ReCap is the authority: the CLI accepts an approval only when OpenKey's binding and relayed delegation state exactly the signed permissions, which must stay inside the request and match the session key, owner, origins and lifetime; `permissions`/`declined` are derived from the signed grant, and OpenKey `invalid_scope` surfaces as `SCOPE_REJECTED`. A profile that recorded an owner is pinned to it on scoped and device login (except local-owner-key profiles); device login refuses local-owner-key profiles (`LOCAL_OWNER_PROFILE`) and will not replace a live session with a different scope without `--replace-session` (`SESSION_IN_USE`). Device logins honor the profile's self-hosted `openkeyHost`, accept verification pages only on the OpenKey site, and name OpenKey when it is unreachable. Owner addresses compare case-insensitively (EIP-55 or lowercase) while chain id and space name compare exactly. `--device` requires `--manifest`; non-interactive `auth login` no longer switches to device mode or waits silently on a browser (`INTERACTIVE_LOGIN_REQUIRED`). The built-in `builtin:share-publishing` manifest requests only `tinycloud.capabilities/read` on `""` (OpenKey requires it to sign any delegation), KV get/put on `xyz.tinycloud.share/shares/` and get/metadata/put/list on `shares/`; `tc enable share` uses it.

  `--expiry` is enforced against the signed session on every login path; OpenKey `--expiry` takes durations only (ISO dates are refused up front, since OpenKey signs approval time plus a lifetime). Logins commit under the profile lock after re-reading profile, key and session: a change while approval was pending refuses with `PROFILE_CHANGED_DURING_LOGIN`, and a live session is replaced only by an approved scope that keeps all of it (`SESSION_IN_USE` otherwise, for scoped browser and device login alike). Every login keeps the profile's recorded owner and records only a signature-verified owner. Browser `--expiry` reaches OpenKey as seconds. Login commits and the `ProfileManager` profile, key and session writers take the profile lock, and read-modify-write updates hold it for the whole transaction. A failed commit write restores the pre-commit state, attempting every restore write; if restoring fails too, or interrupted state is found (including a session naming an owner the profile does not record), it surfaces as `PROFILE_STATE_INCONSISTENT`. A profile lock timeout reaching the CLI error handler is reported as `PROFILE_LOCK_TIMEOUT` with a retry hint. Signed ReCap caveats (including JSON `null` values, which the WASM verifier returns as `undefined`) are recorded with the session's permissions, and a renewal that adds a caveat to an action the live session holds unrestricted counts as narrowing (`SESSION_IN_USE`). An unscoped login whose callback carries no complete proof saves no SIWE or signature, so an unsigned expiry is never read back. Session authority fields (owner, permissions, expiry, signed-scope marker) are set only from verified proofs; `tc init` uses the same verified commit. `withProfileLock` in operations is reentrant only for the acquiring call chain and lock path while the acquisition lasts, takes the lock with an exclusive `mkdir` (the primitive older releases use) and holds it only once it has `link`ed a fully written owner record into it (`link` never replaces; EEXIST or ENOENT means not acquired, and the attempt retries), never renames anything onto the lock or its owner record, and reclaims an ownerless lock directory older than the stale threshold only by `rmdir`, so only while it is empty; claim files left by a process killed mid-recovery are removed first (never `owner.json`), and owner files a crashed acquirer staged are removed once aged. Dead-holder recovery claims the owner record with a hard link instead of moving it, so a recoverer acting on an outdated observation can no longer move a live holder's record away and restore it after that holder released (which left the lock blocked until the stale threshold); release removes its own verified record. Recovery is fenced: a recoverer that took longer than half the stale threshold between its claim and removing the dead holder's record, or a cleanup between its age check and removing claims, abandons that step (dropping only its own claim) and retries, so a recoverer paused while cleanup and a new holder moved on can never remove that holder's record. Port manifest-scoped first login (`auth login --manifest/--owner/--expiry` with signed-proof verification), the `tc context` command, and the packaged core `tc-cli` skill (SKILL, AUTH, REFERENCE, INSTALL, release.json) from the 0.10 line. The default host is now `https://tee.node.tinycloud.xyz` in the CLI, operations and MCP HTTP CLI; only an explicit `--host` is stored on a profile. Profile state is written 0600 in 0700 directories, and directories or grant history created by older releases are tightened on the next write.

  `tc share publish` authorization hints for OpenKey profiles now name `tc --profile <name> auth login --device --manifest builtin:share-publishing` (or `tc --profile <name> enable share`), and scope denials name the `builtin:share-publishing` scope; local-key profiles keep `auth login --method local`. The packaged `tc-cli` skill requires CLI `>=1.0.0-beta.17`, the first release with these commands. Device login validates that OpenKey's relay key is a P-256 point before deriving the relay secret. `tc auth request --grant --device` keeps signed ReCap caveats on the granted resources, in the stored delegation and in the reported grant, so a caveated grant is never replayed as unrestricted.

- Updated dependencies [48eca36]
  - @tinycloud/node-sdk@3.0.0-beta.16

## 0.3.3-beta.13

### Patch Changes

- Updated dependencies [2e9db6e]
  - @tinycloud/sdk-core@3.0.0-beta.15
  - @tinycloud/node-sdk@3.0.0-beta.15

## 0.3.3-beta.12

### Patch Changes

- Updated dependencies [d8b122e]
- Updated dependencies [d8b122e]
- Updated dependencies [d8b122e]
- Updated dependencies [d8b122e]
  - @tinycloud/node-sdk@3.0.0-beta.14
  - @tinycloud/sdk-core@3.0.0-beta.14

## 0.3.3-beta.11

### Patch Changes

- Updated dependencies [036ce34]
  - @tinycloud/sdk-core@3.0.0-beta.13
  - @tinycloud/node-sdk@3.0.0-beta.13

## 0.3.3-beta.10

### Patch Changes

- Updated dependencies [cc27c3a]
  - @tinycloud/sdk-core@3.0.0-beta.12
  - @tinycloud/node-sdk@3.0.0-beta.12

## 0.3.3-beta.9

### Patch Changes

- Updated dependencies [12e5c4d]
  - @tinycloud/sdk-core@3.0.0-beta.11
  - @tinycloud/node-sdk@3.0.0-beta.11

## 0.3.3-beta.8

### Patch Changes

- Updated dependencies [b852650]
  - @tinycloud/sdk-core@3.0.0-beta.10
  - @tinycloud/node-sdk@3.0.0-beta.10

## 0.3.3-beta.7

### Patch Changes

- Updated dependencies [c690844]
  - @tinycloud/sdk-core@3.0.0-beta.9
  - @tinycloud/node-sdk@3.0.0-beta.9

## 0.3.3-beta.6

### Patch Changes

- Updated dependencies [46c83a7]
  - @tinycloud/sdk-core@3.0.0-beta.8
  - @tinycloud/node-sdk@3.0.0-beta.8

## 0.3.3-beta.5

### Patch Changes

- Updated dependencies [657c1ff]
  - @tinycloud/sdk-core@3.0.0-beta.7
  - @tinycloud/node-sdk@3.0.0-beta.7

## 0.3.3-beta.4

### Patch Changes

- Updated dependencies [31043b5]
  - @tinycloud/sdk-core@3.0.0-beta.6
  - @tinycloud/node-sdk@3.0.0-beta.6

## 0.3.3-beta.3

### Patch Changes

- @tinycloud/sdk-core@3.0.0-beta.5
- @tinycloud/node-sdk@3.0.0-beta.5

## 0.3.3-beta.2

### Patch Changes

- Updated dependencies [b0069f7]
  - @tinycloud/sdk-core@3.0.0-beta.2
  - @tinycloud/node-sdk@3.0.0-beta.2

## 0.3.3-beta.1

### Patch Changes

- Updated dependencies [4b60562]
  - @tinycloud/sdk-core@3.0.0-beta.1
  - @tinycloud/node-sdk@3.0.0-beta.1

## 0.3.3-beta.0

### Patch Changes

- Updated dependencies [ce34dc1]
  - @tinycloud/sdk-core@3.0.0-beta.0
  - @tinycloud/node-sdk@3.0.0-beta.0

## 0.3.2

### Patch Changes

- 44ecf56: Release the exact-head session invocation APIs and canonical recipient-DID policy support used by Share.
- Updated dependencies [746cb02]
- Updated dependencies [d1d675b]
- Updated dependencies [44ecf56]
- Updated dependencies [b38dd12]
- Updated dependencies [68faad4]
- Updated dependencies [9fd8752]
- Updated dependencies [4ce36a6]
- Updated dependencies [55e76c5]
- Updated dependencies [cc75957]
- Updated dependencies [a7e3668]
- Updated dependencies [e525137]
- Updated dependencies [ba9c983]
- Updated dependencies [10363b6]
- Updated dependencies [b5d2e10]
- Updated dependencies [f0842d8]
- Updated dependencies [d894c57]
- Updated dependencies [7805213]
  - @tinycloud/sdk-core@2.11.0
  - @tinycloud/node-sdk@2.11.0

## 0.3.2-beta.11

### Patch Changes

- Updated dependencies [7805213]
  - @tinycloud/node-sdk@2.11.0-beta.12
  - @tinycloud/sdk-core@2.11.0-beta.12

## 0.3.2-beta.10

### Patch Changes

- Updated dependencies [d894c57]
  - @tinycloud/sdk-core@2.11.0-beta.11
  - @tinycloud/node-sdk@2.11.0-beta.11

## 0.3.2-beta.9

### Patch Changes

- Updated dependencies [b38dd12]
- Updated dependencies [cc75957]
- Updated dependencies [a7e3668]
- Updated dependencies [e525137]
- Updated dependencies [ba9c983]
  - @tinycloud/sdk-core@2.11.0-beta.10
  - @tinycloud/node-sdk@2.11.0-beta.10

## 0.3.2-beta.8

### Patch Changes

- Updated dependencies [10363b6]
  - @tinycloud/sdk-core@2.11.0-beta.9
  - @tinycloud/node-sdk@2.11.0-beta.9

## 0.3.2-beta.7

### Patch Changes

- Updated dependencies [68faad4]
  - @tinycloud/sdk-core@2.11.0-beta.8
  - @tinycloud/node-sdk@2.11.0-beta.8

## 0.3.2-beta.6

### Patch Changes

- 44ecf56: Release the exact-head session invocation APIs and canonical recipient-DID policy support used by Share.
- Updated dependencies [44ecf56]
- Updated dependencies [9fd8752]
- Updated dependencies [4ce36a6]
  - @tinycloud/node-sdk@2.11.0-beta.7
  - @tinycloud/sdk-core@2.11.0-beta.7

## 0.3.2-beta.4

### Patch Changes

- Updated dependencies [f0842d8]
  - @tinycloud/sdk-core@2.11.0-beta.5
  - @tinycloud/node-sdk@2.11.0-beta.5

## 0.3.2-beta.3

### Patch Changes

- Updated dependencies [746cb02]
  - @tinycloud/sdk-core@2.11.0-beta.4
  - @tinycloud/node-sdk@2.11.0-beta.4

## 0.3.2-beta.2

### Patch Changes

- Updated dependencies [55e76c5]
  - @tinycloud/sdk-core@2.11.0-beta.3
  - @tinycloud/node-sdk@2.11.0-beta.3

## 0.3.2-beta.1

### Patch Changes

- Updated dependencies [d1d675b]
  - @tinycloud/sdk-core@2.11.0-beta.1
  - @tinycloud/node-sdk@2.11.0-beta.1

## 0.3.2-beta.0

### Patch Changes

- Updated dependencies [b5d2e10]
  - @tinycloud/sdk-core@2.11.0-beta.0
  - @tinycloud/node-sdk@2.11.0-beta.0

## 0.3.1

### Patch Changes

- Updated dependencies [28cc430]
- Updated dependencies [48a5408]
  - @tinycloud/node-sdk@2.10.0
  - @tinycloud/sdk-core@2.10.0

## 0.3.1-beta.1

### Patch Changes

- Updated dependencies [48a5408]
  - @tinycloud/sdk-core@2.10.0-beta.1
  - @tinycloud/node-sdk@2.10.0-beta.1

## 0.3.1-beta.0

### Patch Changes

- Updated dependencies [28cc430]
  - @tinycloud/node-sdk@2.10.0-beta.0
  - @tinycloud/sdk-core@2.10.0-beta.0

## 0.3.0

### Minor Changes

- f0febf1: Add per-invocation state isolation and a hosted OAuth-protected Streamable HTTP MCP server with delegated OpenKey approval flows.

## 0.3.0-beta.0

### Minor Changes

- f0febf1: Add per-invocation state isolation and a hosted OAuth-protected Streamable HTTP MCP server with delegated OpenKey approval flows.

## 0.2.1

### Patch Changes

- Updated dependencies [9afb09c]
  - @tinycloud/sdk-core@2.9.0
  - @tinycloud/node-sdk@2.9.0

## 0.2.0

### Minor Changes

- 7ecd455: Add bounded, byte-safe TinyCloud KV CRUD operations to MCP, including metadata reads, tagged content writes, create/replace/upsert modes, optimistic concurrency with ETags, and conditional deletion.
- 7ecd455: Add exact-database delegated SQLite schema inspection, parser-approved bounded read queries, and explicitly acknowledged parameterized DML execution to the canonical operations and MCP surfaces. SQL requests now forward hard row and byte limits where applicable and encode BLOB parameters byte-exactly.

### Patch Changes

- @tinycloud/node-sdk@2.8.0
- @tinycloud/sdk-core@2.8.0

## 0.2.0-beta.0

### Minor Changes

- 7ecd455: Add bounded, byte-safe TinyCloud KV CRUD operations to MCP, including metadata reads, tagged content writes, create/replace/upsert modes, optimistic concurrency with ETags, and conditional deletion.
- 7ecd455: Add exact-database delegated SQLite schema inspection, parser-approved bounded read queries, and explicitly acknowledged parameterized DML execution to the canonical operations and MCP surfaces. SQL requests now forward hard row and byte limits where applicable and encode BLOB parameters byte-exactly.

### Patch Changes

- @tinycloud/node-sdk@2.8.0-beta.0
- @tinycloud/sdk-core@2.8.0-beta.0

## 0.1.0

### Minor Changes

- 1269a58: Add canonical delegated account-space, application, and generic non-secrets KV exploration operations. Publish the beta MCP package with four corresponding read-only tools and a documented exact request, owner grant, import, restart, and retry workflow. Allow a fresh delegate profile to bootstrap from its first request-bound delegation while preserving canonical import validation.
- 2721f9d: Add the experimental operations package foundation and depend on its exact prerelease from the CLI.
- abe8083: Implement the canonical `tinycloud.secrets.get` operation and route `tc secrets get` through it while preserving Commander rendering and owner authorization behavior.
- 1c73181: Add the public `@tinycloud/operations/artifacts` authority and v1 permission-artifact APIs.

### Patch Changes

- 492a656: Bind request-bound delegation imports to the selected profile host before activation, including legacy hostless portable delegations.
- 5172cf9: Reject persisted profiles whose posture conflicts with their authentication method so delegated sessions cannot enter local owner authentication.
- 5c32147: Add the I5 Commander coverage ledger and deterministic registration check,
  cross-surface canonical-envelope fixtures, generated coverage references,
  source-boundary checks, and Node 20 packed-artifact conformance gates. MCP
  publication remains deferred while the SDK v2 beta gate is `unpublishable-defer`.
- a5b557a: Resolve explicit-key secret spaces against the authenticated owner and keep
  local-owner acquisition and its single retry on one live runtime session.
- f5b1c75: Repair I2 release artifacts: bundle ESM-only multiformats dependencies for Node CommonJS consumers, preserve safe delegation mismatch details, and publish the canonical CLI auth import route.
- 39cc055: Register the reviewed I2 status and authentication operations and publish their deterministic catalog metadata.
- b982b90: Declare Node 20 or newer as the supported runtime floor for the complete published SDK and Operations graph, including the CLI and Node WASM bindings.
- 96b9e21: Require explicit owner-profile opt-in for authenticated operations, harden exact delegation request/import handling, and expose verified base-session authority to canonical auth operations.
- 160c16e: Canonicalize JSON object keys using RFC 8785 raw UTF-16 code-unit ordering,
  including astral-plane keys. Update operations' exact sdk-core dependency at
  release so retry digests use the corrected canonicalization.
- c62f72a: Add the experimental delegated stdio MCP projection with generated operation
  schemas, pinned startup profile selection, canonical structured envelopes, and
  the packaged delegated-secrets workflow. Expose the existing operations-owned
  profile-name resolver needed to pin a projection process before stdio starts.
- Updated dependencies [367c17c]
- Updated dependencies [1269a58]
- Updated dependencies [f6048b7]
- Updated dependencies [f7a1d4f]
- Updated dependencies [f5b1c75]
- Updated dependencies [4dee0a9]
- Updated dependencies [b982b90]
- Updated dependencies [160c16e]
- Updated dependencies [d6d5ef1]
- Updated dependencies [8777823]
- Updated dependencies [cd8c11f]
- Updated dependencies [1606a6f]
- Updated dependencies [96b9e21]
  - @tinycloud/node-sdk@2.7.0
  - @tinycloud/sdk-core@2.7.0

## 0.1.0-beta.2

### Minor Changes

- 1269a58: Add canonical delegated account-space, application, and generic non-secrets KV exploration operations. Publish the beta MCP package with four corresponding read-only tools and a documented exact request, owner grant, import, restart, and retry workflow. Allow a fresh delegate profile to bootstrap from its first request-bound delegation while preserving canonical import validation.

### Patch Changes

- Updated dependencies [1269a58]
  - @tinycloud/node-sdk@2.7.0-beta.5

## 0.1.0-beta.1

### Minor Changes

- 2721f9d: Add the experimental operations package foundation and depend on its exact prerelease from the CLI.
- abe8083: Implement the canonical `tinycloud.secrets.get` operation and route `tc secrets get` through it while preserving Commander rendering and owner authorization behavior.
- 1c73181: Add the public `@tinycloud/operations/artifacts` authority and v1 permission-artifact APIs.

### Patch Changes

- 492a656: Bind request-bound delegation imports to the selected profile host before activation, including legacy hostless portable delegations.
- 5172cf9: Reject persisted profiles whose posture conflicts with their authentication method so delegated sessions cannot enter local owner authentication.
- 5c32147: Add the I5 Commander coverage ledger and deterministic registration check,
  cross-surface canonical-envelope fixtures, generated coverage references,
  source-boundary checks, and Node 20 packed-artifact conformance gates. MCP
  publication remains deferred while the SDK v2 beta gate is `unpublishable-defer`.
- a5b557a: Resolve explicit-key secret spaces against the authenticated owner and keep
  local-owner acquisition and its single retry on one live runtime session.
- f5b1c75: Repair I2 release artifacts: bundle ESM-only multiformats dependencies for Node CommonJS consumers, preserve safe delegation mismatch details, and publish the canonical CLI auth import route.
- 39cc055: Register the reviewed I2 status and authentication operations and publish their deterministic catalog metadata.
- b982b90: Declare Node 20 or newer as the supported runtime floor for the complete published SDK and Operations graph, including the CLI and Node WASM bindings.
- 96b9e21: Require explicit owner-profile opt-in for authenticated operations, harden exact delegation request/import handling, and expose verified base-session authority to canonical auth operations.
- 160c16e: Canonicalize JSON object keys using RFC 8785 raw UTF-16 code-unit ordering,
  including astral-plane keys. Update operations' exact sdk-core dependency at
  release so retry digests use the corrected canonicalization.
- c62f72a: Add the experimental delegated stdio MCP projection with generated operation
  schemas, pinned startup profile selection, canonical structured envelopes, and
  the packaged delegated-secrets workflow. Expose the existing operations-owned
  profile-name resolver needed to pin a projection process before stdio starts.
- Updated dependencies [f5b1c75]
- Updated dependencies [b982b90]
- Updated dependencies [160c16e]
- Updated dependencies [d6d5ef1]
- Updated dependencies [8777823]
- Updated dependencies [cd8c11f]
- Updated dependencies [1606a6f]
- Updated dependencies [96b9e21]
  - @tinycloud/sdk-core@2.7.0-beta.4
  - @tinycloud/node-sdk@2.7.0-beta.4
