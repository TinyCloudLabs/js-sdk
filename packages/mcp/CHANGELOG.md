# @tinycloud/mcp

## 0.4.0-beta.12

### Patch Changes

- Updated dependencies [dca972f]
- Updated dependencies [dca972f]
  - @tinycloud/node-sdk@3.1.0-beta.8
  - @tinycloud/operations@0.4.0-beta.12
  - @tinycloud/node-sdk-wasm@1.7.7-beta.0

## 0.4.0-beta.11

### Minor Changes

- e2ec154: TC-625: Every command and tool reports full TinyCloud storage the same way.
  - CLI: a write refused because storage is full (`STORAGE_QUOTA_EXCEEDED`) or too small for the write (`STORAGE_LIMIT_REACHED`) exits with the new code 10 (`ExitCode.STORAGE_FULL`) from every command, including `kv`, `sql`, `duckdb`, `vars`, `vault`, `secrets`, `account` and `share`. It prints one message, `TinyCloud storage is full; nothing was written.`, with a hint that gives the account totals when the SDK reports them (`371.7 MiB used of 100 MiB (free plan)`), says reading still works, and links to https://account.tinycloud.xyz/billing. It never shows the per-space limit or the switch-hosts network hint. `tc sql copy` that fills storage part-way keeps its progress instead (`Insert into "notes" failed after 2 row(s): TinyCloud storage is full.`). The node's storage text is read only from an uncoded 402 or 413 response; an error with another code, such as a local `ENOENT`, keeps its own mapping. Behaviour change: `tc kv put` exited 1 and `tc share` exited 4 for a full space; both now exit 10. `tc share` keeps 8 for `UNSAFE_FILENAME`/`OUTPUT_EXISTS` and 9 for notify partial failure. `tc share` reports a write larger than the remaining storage as `STORAGE_LIMIT_REACHED` instead of `UPLOAD_FAILED`.
  - Operations and MCP: a new `STORAGE_QUOTA_EXCEEDED` operation error code with `retryable: false`. The message says nothing was written, reading still works and the owner must free up space or upgrade; `details.account` carries the account totals when known. Behaviour change: a KV write on full storage was a retryable `NODE_ERROR`, and a SQL write was `SQL_EXECUTION_FAILED` with an unknown outcome.
  - VFS: a write on full storage fails with `ENOSPC` instead of `EIO`.

### Patch Changes

- Updated dependencies [e2ec154]
  - @tinycloud/operations@0.4.0-beta.11

## 0.4.0-beta.10

### Patch Changes

- @tinycloud/node-sdk@3.1.0-beta.7
- @tinycloud/operations@0.4.0-beta.10

## 0.4.0-beta.9

### Minor Changes

- 045c2d3: Classify KV and SQL HTTP authorization refusals in operation and MCP structured results. A plain 401 is nonretryable `AUTH_REQUIRED`; 403 or a 401 naming a validated missing capability is nonretryable `PERMISSION_DENIED`, so an agent does not retry signing in when a capability grant is needed. Keep 5xx node failures retryable except uncertain SQL writes, and never expose node response text or transport metadata in canonical results.

### Patch Changes

- Updated dependencies [045c2d3]
- Updated dependencies [045c2d3]
  - @tinycloud/operations@0.4.0-beta.9
  - @tinycloud/node-sdk@3.1.0-beta.6

## 0.3.4-beta.8

### Patch Changes

- Updated dependencies [7edc599]
  - @tinycloud/operations@0.4.0-beta.8

## 0.3.4-beta.7

### Patch Changes

- b7fd979: The README describes how imported delegations are bound to their requests, how delegations stored by earlier releases are migrated once, and what a record without a binding does.
- Updated dependencies [b7fd979]
- Updated dependencies [b7fd979]
  - @tinycloud/node-sdk@3.1.0-beta.5
  - @tinycloud/operations@0.4.0-beta.7

## 0.3.4-beta.6

### Patch Changes

- @tinycloud/node-sdk@3.1.0-beta.4
- @tinycloud/operations@0.3.4-beta.6

## 0.3.4-beta.5

### Patch Changes

- @tinycloud/node-sdk@3.1.0-beta.3
- @tinycloud/operations@0.3.4-beta.5

## 0.3.4-beta.4

### Patch Changes

- Updated dependencies [c923361]
  - @tinycloud/operations@0.3.4-beta.4

## 0.3.4-beta.3

### Patch Changes

- Updated dependencies [a074fa5]
  - @tinycloud/node-sdk@3.1.0-beta.2
  - @tinycloud/operations@0.3.4-beta.3

## 0.3.4-beta.2

### Patch Changes

- Updated dependencies [0652195]
  - @tinycloud/node-sdk@3.1.0-beta.1
  - @tinycloud/operations@0.3.4-beta.2

## 0.3.4-beta.1

### Patch Changes

- Updated dependencies [f25aa05]
  - @tinycloud/operations@0.3.4-beta.1

## 0.3.4-beta.0

### Patch Changes

- @tinycloud/node-sdk@3.0.1-beta.0
- @tinycloud/operations@0.3.4-beta.0

## 0.3.3

### Patch Changes

- 48eca36: TC-540: `tc auth login --device --manifest FILE [--expiry DUR] [--owner DID] [--replace-session]` and `tc auth request --manifest FILE --grant --device` request exactly a KV-scoped manifest's permissions through OpenKey device authorization (SQL stays on browser login). The signed SIWE ReCap is the authority: the CLI accepts an approval only when OpenKey's binding and relayed delegation state exactly the signed permissions, which must stay inside the request and match the session key, owner, origins and lifetime; `permissions`/`declined` are derived from the signed grant, and OpenKey `invalid_scope` surfaces as `SCOPE_REJECTED`. A profile that recorded an owner is pinned to it on scoped and device login (except local-owner-key profiles); device login refuses local-owner-key profiles (`LOCAL_OWNER_PROFILE`) and will not replace a live session with a different scope without `--replace-session` (`SESSION_IN_USE`). Device logins honor the profile's self-hosted `openkeyHost`, accept verification pages only on the OpenKey site, and name OpenKey when it is unreachable. Owner addresses compare case-insensitively (EIP-55 or lowercase) while chain id and space name compare exactly. `--device` requires `--manifest`; non-interactive `auth login` no longer switches to device mode or waits silently on a browser (`INTERACTIVE_LOGIN_REQUIRED`). The built-in `builtin:share-publishing` manifest requests only `tinycloud.capabilities/read` on `""` (OpenKey requires it to sign any delegation), KV get/put on `xyz.tinycloud.share/shares/` and get/metadata/put/list on `shares/`; `tc enable share` uses it.

  `--expiry` is enforced against the signed session on every login path; OpenKey `--expiry` takes durations only (ISO dates are refused up front, since OpenKey signs approval time plus a lifetime). Logins commit under the profile lock after re-reading profile, key and session: a change while approval was pending refuses with `PROFILE_CHANGED_DURING_LOGIN`, and a live session is replaced only by an approved scope that keeps all of it (`SESSION_IN_USE` otherwise, for scoped browser and device login alike). Every login keeps the profile's recorded owner and records only a signature-verified owner. Browser `--expiry` reaches OpenKey as seconds. Login commits and the `ProfileManager` profile, key and session writers take the profile lock, and read-modify-write updates hold it for the whole transaction. A failed commit write restores the pre-commit state, attempting every restore write; if restoring fails too, or interrupted state is found (including a session naming an owner the profile does not record), it surfaces as `PROFILE_STATE_INCONSISTENT`. A profile lock timeout reaching the CLI error handler is reported as `PROFILE_LOCK_TIMEOUT` with a retry hint. Signed ReCap caveats (including JSON `null` values, which the WASM verifier returns as `undefined`) are recorded with the session's permissions, and a renewal that adds a caveat to an action the live session holds unrestricted counts as narrowing (`SESSION_IN_USE`). An unscoped login whose callback carries no complete proof saves no SIWE or signature, so an unsigned expiry is never read back. Session authority fields (owner, permissions, expiry, signed-scope marker) are set only from verified proofs; `tc init` uses the same verified commit. `withProfileLock` in operations is reentrant only for the acquiring call chain and lock path while the acquisition lasts, takes the lock with an exclusive `mkdir` (the primitive older releases use) and holds it only once it has `link`ed a fully written owner record into it (`link` never replaces; EEXIST or ENOENT means not acquired, and the attempt retries), never renames anything onto the lock or its owner record, and reclaims an ownerless lock directory older than the stale threshold only by `rmdir`, so only while it is empty; claim files left by a process killed mid-recovery are removed first (never `owner.json`), and owner files a crashed acquirer staged are removed once aged. Dead-holder recovery claims the owner record with a hard link instead of moving it, so a recoverer acting on an outdated observation can no longer move a live holder's record away and restore it after that holder released (which left the lock blocked until the stale threshold); release removes its own verified record. Recovery is fenced: a recoverer that took longer than half the stale threshold between its claim and removing the dead holder's record, or a cleanup between its age check and removing claims, abandons that step (dropping only its own claim) and retries, so a recoverer paused while cleanup and a new holder moved on can never remove that holder's record. Port manifest-scoped first login (`auth login --manifest/--owner/--expiry` with signed-proof verification), the `tc context` command, and the packaged core `tc-cli` skill (SKILL, AUTH, REFERENCE, INSTALL, release.json) from the 0.10 line. The default host is now `https://tee.node.tinycloud.xyz` in the CLI, operations and MCP HTTP CLI; only an explicit `--host` is stored on a profile. Profile state is written 0600 in 0700 directories, and directories or grant history created by older releases are tightened on the next write.

  `tc share publish` authorization hints for OpenKey profiles now name `tc --profile <name> auth login --device --manifest builtin:share-publishing` (or `tc --profile <name> enable share`), and scope denials name the `builtin:share-publishing` scope; local-key profiles keep `auth login --method local`. The packaged `tc-cli` skill requires CLI `>=1.0.0-beta.17`, the first release with these commands. Device login validates that OpenKey's relay key is a P-256 point before deriving the relay secret. `tc auth request --grant --device` keeps signed ReCap caveats on the granted resources, in the stored delegation and in the reported grant, so a caveated grant is never replayed as unrestricted.

- 7340498: The hosted MCP now stores an approved operation delegation only when the wallet that signed it is the OpenKey account whose MCP request created the approval link, the same check `tinycloud_connect` already applied. A delegation signed by any other account is refused before anything is written, and `/connect/callback` answers `403` with code `approval_owner_mismatch` and a fixed message. The OpenKey approval page now shows which TinyCloud account requested the approval.
- Updated dependencies [46c83a7]
- Updated dependencies [036ce34]
- Updated dependencies [c690844]
- Updated dependencies [31043b5]
- Updated dependencies [b852650]
- Updated dependencies [70e6c95]
- Updated dependencies [d8b122e]
- Updated dependencies [d8b122e]
- Updated dependencies [d8b122e]
- Updated dependencies [d8b122e]
- Updated dependencies [48eca36]
- Updated dependencies [48eca36]
- Updated dependencies [877097d]
  - @tinycloud/node-sdk@3.0.0
  - @tinycloud/operations@0.3.3

## 0.3.3-beta.19

### Patch Changes

- Updated dependencies [877097d]
  - @tinycloud/node-sdk@3.0.0-beta.20
  - @tinycloud/operations@0.3.3-beta.18

## 0.3.3-beta.18

### Patch Changes

- Updated dependencies [70e6c95]
  - @tinycloud/node-sdk@3.0.0-beta.19
  - @tinycloud/operations@0.3.3-beta.17

## 0.3.3-beta.17

### Patch Changes

- 7340498: The hosted MCP now stores an approved operation delegation only when the wallet that signed it is the OpenKey account whose MCP request created the approval link, the same check `tinycloud_connect` already applied. A delegation signed by any other account is refused before anything is written, and `/connect/callback` answers `403` with code `approval_owner_mismatch` and a fixed message. The OpenKey approval page now shows which TinyCloud account requested the approval.

## 0.3.3-beta.16

### Patch Changes

- @tinycloud/node-sdk@3.0.0-beta.18
- @tinycloud/operations@0.3.3-beta.16

## 0.3.3-beta.15

### Patch Changes

- @tinycloud/node-sdk@3.0.0-beta.17
- @tinycloud/operations@0.3.3-beta.15

## 0.3.3-beta.14

### Patch Changes

- 48eca36: TC-540: `tc auth login --device --manifest FILE [--expiry DUR] [--owner DID] [--replace-session]` and `tc auth request --manifest FILE --grant --device` request exactly a KV-scoped manifest's permissions through OpenKey device authorization (SQL stays on browser login). The signed SIWE ReCap is the authority: the CLI accepts an approval only when OpenKey's binding and relayed delegation state exactly the signed permissions, which must stay inside the request and match the session key, owner, origins and lifetime; `permissions`/`declined` are derived from the signed grant, and OpenKey `invalid_scope` surfaces as `SCOPE_REJECTED`. A profile that recorded an owner is pinned to it on scoped and device login (except local-owner-key profiles); device login refuses local-owner-key profiles (`LOCAL_OWNER_PROFILE`) and will not replace a live session with a different scope without `--replace-session` (`SESSION_IN_USE`). Device logins honor the profile's self-hosted `openkeyHost`, accept verification pages only on the OpenKey site, and name OpenKey when it is unreachable. Owner addresses compare case-insensitively (EIP-55 or lowercase) while chain id and space name compare exactly. `--device` requires `--manifest`; non-interactive `auth login` no longer switches to device mode or waits silently on a browser (`INTERACTIVE_LOGIN_REQUIRED`). The built-in `builtin:share-publishing` manifest requests only `tinycloud.capabilities/read` on `""` (OpenKey requires it to sign any delegation), KV get/put on `xyz.tinycloud.share/shares/` and get/metadata/put/list on `shares/`; `tc enable share` uses it.

  `--expiry` is enforced against the signed session on every login path; OpenKey `--expiry` takes durations only (ISO dates are refused up front, since OpenKey signs approval time plus a lifetime). Logins commit under the profile lock after re-reading profile, key and session: a change while approval was pending refuses with `PROFILE_CHANGED_DURING_LOGIN`, and a live session is replaced only by an approved scope that keeps all of it (`SESSION_IN_USE` otherwise, for scoped browser and device login alike). Every login keeps the profile's recorded owner and records only a signature-verified owner. Browser `--expiry` reaches OpenKey as seconds. Login commits and the `ProfileManager` profile, key and session writers take the profile lock, and read-modify-write updates hold it for the whole transaction. A failed commit write restores the pre-commit state, attempting every restore write; if restoring fails too, or interrupted state is found (including a session naming an owner the profile does not record), it surfaces as `PROFILE_STATE_INCONSISTENT`. A profile lock timeout reaching the CLI error handler is reported as `PROFILE_LOCK_TIMEOUT` with a retry hint. Signed ReCap caveats (including JSON `null` values, which the WASM verifier returns as `undefined`) are recorded with the session's permissions, and a renewal that adds a caveat to an action the live session holds unrestricted counts as narrowing (`SESSION_IN_USE`). An unscoped login whose callback carries no complete proof saves no SIWE or signature, so an unsigned expiry is never read back. Session authority fields (owner, permissions, expiry, signed-scope marker) are set only from verified proofs; `tc init` uses the same verified commit. `withProfileLock` in operations is reentrant only for the acquiring call chain and lock path while the acquisition lasts, takes the lock with an exclusive `mkdir` (the primitive older releases use) and holds it only once it has `link`ed a fully written owner record into it (`link` never replaces; EEXIST or ENOENT means not acquired, and the attempt retries), never renames anything onto the lock or its owner record, and reclaims an ownerless lock directory older than the stale threshold only by `rmdir`, so only while it is empty; claim files left by a process killed mid-recovery are removed first (never `owner.json`), and owner files a crashed acquirer staged are removed once aged. Dead-holder recovery claims the owner record with a hard link instead of moving it, so a recoverer acting on an outdated observation can no longer move a live holder's record away and restore it after that holder released (which left the lock blocked until the stale threshold); release removes its own verified record. Recovery is fenced: a recoverer that took longer than half the stale threshold between its claim and removing the dead holder's record, or a cleanup between its age check and removing claims, abandons that step (dropping only its own claim) and retries, so a recoverer paused while cleanup and a new holder moved on can never remove that holder's record. Port manifest-scoped first login (`auth login --manifest/--owner/--expiry` with signed-proof verification), the `tc context` command, and the packaged core `tc-cli` skill (SKILL, AUTH, REFERENCE, INSTALL, release.json) from the 0.10 line. The default host is now `https://tee.node.tinycloud.xyz` in the CLI, operations and MCP HTTP CLI; only an explicit `--host` is stored on a profile. Profile state is written 0600 in 0700 directories, and directories or grant history created by older releases are tightened on the next write.

  `tc share publish` authorization hints for OpenKey profiles now name `tc --profile <name> auth login --device --manifest builtin:share-publishing` (or `tc --profile <name> enable share`), and scope denials name the `builtin:share-publishing` scope; local-key profiles keep `auth login --method local`. The packaged `tc-cli` skill requires CLI `>=1.0.0-beta.17`, the first release with these commands. Device login validates that OpenKey's relay key is a P-256 point before deriving the relay secret. `tc auth request --grant --device` keeps signed ReCap caveats on the granted resources, in the stored delegation and in the reported grant, so a caveated grant is never replayed as unrestricted.

- Updated dependencies [48eca36]
- Updated dependencies [48eca36]
  - @tinycloud/operations@0.3.3-beta.14
  - @tinycloud/node-sdk@3.0.0-beta.16

## 0.3.3-beta.13

### Patch Changes

- @tinycloud/node-sdk@3.0.0-beta.15
- @tinycloud/operations@0.3.3-beta.13

## 0.3.3-beta.12

### Patch Changes

- Updated dependencies [d8b122e]
- Updated dependencies [d8b122e]
- Updated dependencies [d8b122e]
- Updated dependencies [d8b122e]
  - @tinycloud/node-sdk@3.0.0-beta.14
  - @tinycloud/operations@0.3.3-beta.12

## 0.3.3-beta.11

### Patch Changes

- Updated dependencies [036ce34]
  - @tinycloud/node-sdk@3.0.0-beta.13
  - @tinycloud/operations@0.3.3-beta.11

## 0.3.3-beta.10

### Patch Changes

- @tinycloud/node-sdk@3.0.0-beta.12
- @tinycloud/operations@0.3.3-beta.10

## 0.3.3-beta.9

### Patch Changes

- @tinycloud/node-sdk@3.0.0-beta.11
- @tinycloud/operations@0.3.3-beta.9

## 0.3.3-beta.8

### Patch Changes

- Updated dependencies [b852650]
  - @tinycloud/node-sdk@3.0.0-beta.10
  - @tinycloud/operations@0.3.3-beta.8

## 0.3.3-beta.7

### Patch Changes

- Updated dependencies [c690844]
  - @tinycloud/node-sdk@3.0.0-beta.9
  - @tinycloud/operations@0.3.3-beta.7

## 0.3.3-beta.6

### Patch Changes

- Updated dependencies [46c83a7]
  - @tinycloud/node-sdk@3.0.0-beta.8
  - @tinycloud/operations@0.3.3-beta.6

## 0.3.3-beta.5

### Patch Changes

- @tinycloud/node-sdk@3.0.0-beta.7
- @tinycloud/operations@0.3.3-beta.5

## 0.3.3-beta.4

### Patch Changes

- Updated dependencies [31043b5]
  - @tinycloud/node-sdk@3.0.0-beta.6
  - @tinycloud/operations@0.3.3-beta.4

## 0.3.3-beta.3

### Patch Changes

- @tinycloud/node-sdk@3.0.0-beta.5
- @tinycloud/operations@0.3.3-beta.3

## 0.3.3-beta.2

### Patch Changes

- @tinycloud/node-sdk@3.0.0-beta.2
- @tinycloud/operations@0.3.3-beta.2

## 0.3.3-beta.1

### Patch Changes

- @tinycloud/node-sdk@3.0.0-beta.1
- @tinycloud/operations@0.3.3-beta.1

## 0.3.3-beta.0

### Patch Changes

- @tinycloud/node-sdk@3.0.0-beta.0
- @tinycloud/operations@0.3.3-beta.0

## 0.3.2

### Patch Changes

- Updated dependencies [746cb02]
- Updated dependencies [d1d675b]
- Updated dependencies [44ecf56]
- Updated dependencies [b38dd12]
- Updated dependencies [68faad4]
- Updated dependencies [cc75957]
- Updated dependencies [a7e3668]
- Updated dependencies [e525137]
- Updated dependencies [ba9c983]
- Updated dependencies [f0842d8]
- Updated dependencies [d894c57]
- Updated dependencies [7805213]
  - @tinycloud/node-sdk@2.11.0
  - @tinycloud/operations@0.3.2
  - @tinycloud/node-sdk-wasm@1.7.6

## 0.3.2-beta.10

### Patch Changes

- Updated dependencies [7805213]
  - @tinycloud/node-sdk@2.11.0-beta.12
  - @tinycloud/operations@0.3.2-beta.11

## 0.3.2-beta.9

### Patch Changes

- Updated dependencies [d894c57]
  - @tinycloud/node-sdk@2.11.0-beta.11
  - @tinycloud/operations@0.3.2-beta.10

## 0.3.2-beta.8

### Patch Changes

- Updated dependencies [b38dd12]
- Updated dependencies [cc75957]
- Updated dependencies [a7e3668]
- Updated dependencies [e525137]
- Updated dependencies [ba9c983]
  - @tinycloud/node-sdk@2.11.0-beta.10
  - @tinycloud/operations@0.3.2-beta.9

## 0.3.2-beta.7

### Patch Changes

- @tinycloud/node-sdk@2.11.0-beta.9
- @tinycloud/operations@0.3.2-beta.8

## 0.3.2-beta.6

### Patch Changes

- Updated dependencies [68faad4]
  - @tinycloud/node-sdk-wasm@1.7.6-beta.0
  - @tinycloud/node-sdk@2.11.0-beta.8
  - @tinycloud/operations@0.3.2-beta.7

## 0.3.2-beta.5

### Patch Changes

- Updated dependencies [44ecf56]
  - @tinycloud/node-sdk@2.11.0-beta.7
  - @tinycloud/operations@0.3.2-beta.6

## 0.3.2-beta.4

### Patch Changes

- Updated dependencies [f0842d8]
  - @tinycloud/node-sdk@2.11.0-beta.5
  - @tinycloud/operations@0.3.2-beta.4

## 0.3.2-beta.3

### Patch Changes

- Updated dependencies [746cb02]
  - @tinycloud/node-sdk@2.11.0-beta.4
  - @tinycloud/operations@0.3.2-beta.3

## 0.3.2-beta.2

### Patch Changes

- @tinycloud/node-sdk@2.11.0-beta.3
- @tinycloud/operations@0.3.2-beta.2

## 0.3.2-beta.1

### Patch Changes

- Updated dependencies [d1d675b]
  - @tinycloud/node-sdk@2.11.0-beta.1
  - @tinycloud/operations@0.3.2-beta.1

## 0.3.2-beta.0

### Patch Changes

- @tinycloud/node-sdk@2.11.0-beta.0
- @tinycloud/operations@0.3.2-beta.0

## 0.3.1

### Patch Changes

- Updated dependencies [28cc430]
  - @tinycloud/node-sdk@2.10.0
  - @tinycloud/operations@0.3.1

## 0.3.1-beta.1

### Patch Changes

- @tinycloud/node-sdk@2.10.0-beta.1
- @tinycloud/operations@0.3.1-beta.1

## 0.3.1-beta.0

### Patch Changes

- Updated dependencies [28cc430]
  - @tinycloud/node-sdk@2.10.0-beta.0
  - @tinycloud/operations@0.3.1-beta.0

## 0.3.0

### Minor Changes

- f0febf1: Add per-invocation state isolation and a hosted OAuth-protected Streamable HTTP MCP server with delegated OpenKey approval flows.

### Patch Changes

- Updated dependencies [f0febf1]
  - @tinycloud/operations@0.3.0

## 0.3.0-beta.0

### Minor Changes

- f0febf1: Add per-invocation state isolation and a hosted OAuth-protected Streamable HTTP MCP server with delegated OpenKey approval flows.

### Patch Changes

- Updated dependencies [f0febf1]
  - @tinycloud/operations@0.3.0-beta.0

## 0.2.2

### Patch Changes

- @tinycloud/operations@0.2.1

## 0.2.1

### Patch Changes

- a2adb87: Publish the stable 16-tool MCP setup, delegated workflow, KV CRUD, and SQLite
  surface in the npm README and package discovery metadata.

## 0.2.1-beta.0

### Patch Changes

- a2adb87: Publish the stable 16-tool MCP setup, delegated workflow, KV CRUD, and SQLite
  surface in the npm README and package discovery metadata.

## 0.2.0

### Minor Changes

- 7ecd455: Add bounded, byte-safe TinyCloud KV CRUD operations to MCP, including metadata reads, tagged content writes, create/replace/upsert modes, optimistic concurrency with ETags, and conditional deletion.
- 7ecd455: Add exact-database delegated SQLite schema inspection, parser-approved bounded read queries, and explicitly acknowledged parameterized DML execution to the canonical operations and MCP surfaces. SQL requests now forward hard row and byte limits where applicable and encode BLOB parameters byte-exactly.

### Patch Changes

- Updated dependencies [7ecd455]
- Updated dependencies [7ecd455]
  - @tinycloud/operations@0.2.0

## 0.2.0-beta.0

### Minor Changes

- 7ecd455: Add bounded, byte-safe TinyCloud KV CRUD operations to MCP, including metadata reads, tagged content writes, create/replace/upsert modes, optimistic concurrency with ETags, and conditional deletion.
- 7ecd455: Add exact-database delegated SQLite schema inspection, parser-approved bounded read queries, and explicitly acknowledged parameterized DML execution to the canonical operations and MCP surfaces. SQL requests now forward hard row and byte limits where applicable and encode BLOB parameters byte-exactly.

### Patch Changes

- Updated dependencies [7ecd455]
- Updated dependencies [7ecd455]
  - @tinycloud/operations@0.2.0-beta.0

## 0.1.0

### Minor Changes

- 1269a58: Add canonical delegated account-space, application, and generic non-secrets KV exploration operations. Publish the beta MCP package with four corresponding read-only tools and a documented exact request, owner grant, import, restart, and retry workflow. Allow a fresh delegate profile to bootstrap from its first request-bound delegation while preserving canonical import validation.

### Patch Changes

- 5c32147: Add the I5 Commander coverage ledger and deterministic registration check,
  cross-surface canonical-envelope fixtures, generated coverage references,
  source-boundary checks, and Node 20 packed-artifact conformance gates. MCP
  publication remains deferred while the SDK v2 beta gate is `unpublishable-defer`.
- Updated dependencies [492a656]
- Updated dependencies [1269a58]
- Updated dependencies [5172cf9]
- Updated dependencies [5c32147]
- Updated dependencies [a5b557a]
- Updated dependencies [2721f9d]
- Updated dependencies [f5b1c75]
- Updated dependencies [39cc055]
- Updated dependencies [b982b90]
- Updated dependencies [96b9e21]
- Updated dependencies [160c16e]
- Updated dependencies [abe8083]
- Updated dependencies [c62f72a]
- Updated dependencies [1c73181]
  - @tinycloud/operations@0.1.0

## 0.1.0-beta.2

### Minor Changes

- 1269a58: Add canonical delegated account-space, application, and generic non-secrets KV exploration operations. Publish the beta MCP package with four corresponding read-only tools and a documented exact request, owner grant, import, restart, and retry workflow. Allow a fresh delegate profile to bootstrap from its first request-bound delegation while preserving canonical import validation.

### Patch Changes

- Updated dependencies [1269a58]
  - @tinycloud/operations@0.1.0-beta.2

## 0.1.0-beta.1

### Patch Changes

- 5c32147: Add the I5 Commander coverage ledger and deterministic registration check,
  cross-surface canonical-envelope fixtures, generated coverage references,
  source-boundary checks, and Node 20 packed-artifact conformance gates. MCP
  publication remains deferred while the SDK v2 beta gate is `unpublishable-defer`.
- Updated dependencies [492a656]
- Updated dependencies [5172cf9]
- Updated dependencies [5c32147]
- Updated dependencies [a5b557a]
- Updated dependencies [2721f9d]
- Updated dependencies [f5b1c75]
- Updated dependencies [39cc055]
- Updated dependencies [b982b90]
- Updated dependencies [96b9e21]
- Updated dependencies [160c16e]
- Updated dependencies [abe8083]
- Updated dependencies [c62f72a]
- Updated dependencies [1c73181]
  - @tinycloud/operations@0.1.0-beta.1
