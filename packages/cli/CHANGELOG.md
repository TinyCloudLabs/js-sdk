# @tinycloud/cli

## 1.0.0-beta.23

### Patch Changes

- 877097d: TC-599: Scoped OpenKey login can grant an agent read access to named secrets, and the secrets commands are safe to run headless.
  - `auth login --manifest` keeps raw `tinycloud.encryption` network entries in the `encryption` pseudo-space (never in the manifest's space), so the Secret Manager `secrets: { NAME: true }` shape passes first-login validation; the decrypt network uses the EIP-55-checksummed recorded owner or `--owner` (`OWNER_DID_UNKNOWN` otherwise), never the session `did:key`.
  - Every scoped login (browser, paste, device) requests `tinycloud.capabilities/read` on the space root when the manifest lacks it. A signed decrypt nested inside the owner's space is not raw authority: it is reported in `declined`, omitted from saved permissions so a later valid raw renewal is not blocked, and accompanied by an old-OpenKey warning. Foreign-owner decrypt grants are refused; device login refuses encryption and secrets-space manifests up front.
  - Browser `auth request --grant` and secret-read permission escalation verify the owner's signed OpenKey proof against the profile session key, requested space, scope and expiry. Only signed effective permissions are activated and persisted; old nested decrypt, foreign-owner, broadened or missing proof is refused before storage, and activation failure leaves local grants unchanged.
  - `auth login --paste` accepts a final code line without a newline and fails with `PASTE_CODE_MISSING` (exit 3, naming the approval URL) when stdin ends without a code.
  - `secrets get -o FILE` validates the destination and its existing directory before fetching secret bytes, syncs a new 0600 inode, and atomically replaces the destination. A best-effort parent-directory sync follows replacement without turning a completed write into an error. Symlinks, non-regular destinations, and absent parents are refused without unsafe fallback; filesystem output failures identify the destination without leaking the temporary filename.
  - With no TTY on stdin or stderr, `secrets get|list|put|delete` on an OpenKey profile lacking the grant fails with `PERMISSION_DENIED` (exit 5) and a scoped paste-login hint. A missing or real signed expired session fails with `AUTH_REQUIRED` (exit 3) before the canonical get operation or an unscoped browser refresh. Redirecting stdout alone still permits owner approval through stderr and terminal stdin.
  - node-sdk: a decrypt refused with HTTP 401/403 is reported as missing decrypt authority on the invoked network, never on a response-supplied resource or action.
  - node-sdk keeps an owner's space-nested encryption ReCap distinct from a raw network grant when restoring sessions, checking runtime permissions, and deriving further delegations.

- Updated dependencies [877097d]
  - @tinycloud/node-sdk@3.0.0-beta.20
  - @tinycloud/operations@0.3.3-beta.18

## 1.0.0-beta.22

### Patch Changes

- Updated dependencies [70e6c95]
  - @tinycloud/sdk-core@3.0.0-beta.19
  - @tinycloud/node-sdk@3.0.0-beta.19
  - @tinycloud/share-sdk@1.0.0-beta.9
  - @tinycloud/operations@0.3.3-beta.17

## 1.0.0-beta.21

### Patch Changes

- a132b77: `tc share publish` refuses a session whose authority for an anyone-with-link share carries signed restrictions (caveats) before storing anything, so a refused publish no longer leaves an orphaned file. It exits 5 with `PERMISSION_DENIED` and says to approve Share publishing without restrictions on a new, dedicated profile (`tc init --name publisher --key-only && tc --profile publisher enable share`). A caveat only on authority the link does not use (such as `tinycloud.capabilities/read` or the addressed `shares/` prefix) does not block publishing, and a session that lacks the link's authority altogether is also refused with `PERMISSION_DENIED` before upload. Addressed (`--to`) shares and signer-backed local-key profiles are unchanged.

  `SharingService.preflightGenerate({ path, actions, expiry })` reports, without side effects, whether the session's own authority can issue the delegation `generate` would create: `"ok"`, `"caveated"` (only caveated entries cover it) or `"not-covered"`. It does not consult `onRootDelegationNeeded`.

- Updated dependencies [a132b77]
  - @tinycloud/sdk-core@3.0.0-beta.18
  - @tinycloud/node-sdk@3.0.0-beta.18
  - @tinycloud/operations@0.3.3-beta.16

## 1.0.0-beta.20

### Patch Changes

- bf6fbd1: Share publication now applies the share viewer's filename policy: names are NFC-normalized, and control, format (such as U+200B zero-width space and U+202E bidi override), surrogate, and U+2028/U+2029 code points are refused before any content is read or uploaded. share-sdk exports `canonicalShareFilename` and `hasUnsafeFilenameCodePoint`, and `publishTargetShare` reports "filename contains control or invisible characters". `tc share publish` refuses every such filename with `UNSAFE_FILENAME` (exit 8), and addressed shares display the NFC-normalized name.
- Updated dependencies [bf6fbd1]
  - @tinycloud/share-sdk@1.0.0-beta.8
  - @tinycloud/sdk-core@3.0.0-beta.17
  - @tinycloud/node-sdk@3.0.0-beta.17
  - @tinycloud/operations@0.3.3-beta.15

## 1.0.0-beta.19

### Patch Changes

- c79f5f4: TC-575: Report OpenKey device sign-in rate limits as `DEVICE_AUTH_RATE_LIMITED` with a wait hint and any `Retry-After` window.

## 1.0.0-beta.18

### Patch Changes

- b3db51a: `tc share publish` no longer fails with `PERMISSION_DENIED` when a filename contains spaces. A name that has characters other than `A-Z a-z 0-9 . _ -`, starts with anything but a letter or digit, contains `..`, or is longer than 128 characters is stored under a readable URI-safe name (`Edge test (A).md` is stored as `Edge-test-A.md`). It keeps its extension when that is 1-16 ASCII letters or digits; a leading dot is dropped (`.env` becomes `share.env`), and a name without such an extension never gains one. Anyone-with-link pages and `tc share receive` show the stored name; addressed shares keep the original display filename. A full storage quota reports `STORAGE_QUOTA_EXCEEDED`, with used and limit sizes when the node includes them, and other upload failures report `UPLOAD_FAILED`, never server text. `tc kv get`, `put`, `head`, `delete` and `list --prefix` refuse keys with spaces or control characters (`USAGE_ERROR`) before authenticating, because the SDK sends keys unescaped in the node resource URI, and `tc kv put` reports a full quota as `STORAGE_QUOTA_EXCEEDED` (exit 1). Permission errors advise checking the existing scope before requesting it again.

## 1.0.0-beta.17

### Minor Changes

- 48eca36: TC-540: `tc auth login --device --manifest FILE [--expiry DUR] [--owner DID] [--replace-session]` and `tc auth request --manifest FILE --grant --device` request exactly a KV-scoped manifest's permissions through OpenKey device authorization (SQL stays on browser login). The signed SIWE ReCap is the authority: the CLI accepts an approval only when OpenKey's binding and relayed delegation state exactly the signed permissions, which must stay inside the request and match the session key, owner, origins and lifetime; `permissions`/`declined` are derived from the signed grant, and OpenKey `invalid_scope` surfaces as `SCOPE_REJECTED`. A profile that recorded an owner is pinned to it on scoped and device login (except local-owner-key profiles); device login refuses local-owner-key profiles (`LOCAL_OWNER_PROFILE`) and will not replace a live session with a different scope without `--replace-session` (`SESSION_IN_USE`). Device logins honor the profile's self-hosted `openkeyHost`, accept verification pages only on the OpenKey site, and name OpenKey when it is unreachable. Owner addresses compare case-insensitively (EIP-55 or lowercase) while chain id and space name compare exactly. `--device` requires `--manifest`; non-interactive `auth login` no longer switches to device mode or waits silently on a browser (`INTERACTIVE_LOGIN_REQUIRED`). The built-in `builtin:share-publishing` manifest requests only `tinycloud.capabilities/read` on `""` (OpenKey requires it to sign any delegation), KV get/put on `xyz.tinycloud.share/shares/` and get/metadata/put/list on `shares/`; `tc enable share` uses it.

  `--expiry` is enforced against the signed session on every login path; OpenKey `--expiry` takes durations only (ISO dates are refused up front, since OpenKey signs approval time plus a lifetime). Logins commit under the profile lock after re-reading profile, key and session: a change while approval was pending refuses with `PROFILE_CHANGED_DURING_LOGIN`, and a live session is replaced only by an approved scope that keeps all of it (`SESSION_IN_USE` otherwise, for scoped browser and device login alike). Every login keeps the profile's recorded owner and records only a signature-verified owner. Browser `--expiry` reaches OpenKey as seconds. Login commits and the `ProfileManager` profile, key and session writers take the profile lock, and read-modify-write updates hold it for the whole transaction. A failed commit write restores the pre-commit state, attempting every restore write; if restoring fails too, or interrupted state is found (including a session naming an owner the profile does not record), it surfaces as `PROFILE_STATE_INCONSISTENT`. A profile lock timeout reaching the CLI error handler is reported as `PROFILE_LOCK_TIMEOUT` with a retry hint. Signed ReCap caveats (including JSON `null` values, which the WASM verifier returns as `undefined`) are recorded with the session's permissions, and a renewal that adds a caveat to an action the live session holds unrestricted counts as narrowing (`SESSION_IN_USE`). An unscoped login whose callback carries no complete proof saves no SIWE or signature, so an unsigned expiry is never read back. Session authority fields (owner, permissions, expiry, signed-scope marker) are set only from verified proofs; `tc init` uses the same verified commit. `withProfileLock` in operations is reentrant only for the acquiring call chain and lock path while the acquisition lasts, takes the lock with an exclusive `mkdir` (the primitive older releases use) and holds it only once it has `link`ed a fully written owner record into it (`link` never replaces; EEXIST or ENOENT means not acquired, and the attempt retries), never renames anything onto the lock or its owner record, and reclaims an ownerless lock directory older than the stale threshold only by `rmdir`, so only while it is empty; claim files left by a process killed mid-recovery are removed first (never `owner.json`), and owner files a crashed acquirer staged are removed once aged. Dead-holder recovery claims the owner record with a hard link instead of moving it, so a recoverer acting on an outdated observation can no longer move a live holder's record away and restore it after that holder released (which left the lock blocked until the stale threshold); release removes its own verified record. Recovery is fenced: a recoverer that took longer than half the stale threshold between its claim and removing the dead holder's record, or a cleanup between its age check and removing claims, abandons that step (dropping only its own claim) and retries, so a recoverer paused while cleanup and a new holder moved on can never remove that holder's record. Port manifest-scoped first login (`auth login --manifest/--owner/--expiry` with signed-proof verification), the `tc context` command, and the packaged core `tc-cli` skill (SKILL, AUTH, REFERENCE, INSTALL, release.json) from the 0.10 line. The default host is now `https://tee.node.tinycloud.xyz` in the CLI, operations and MCP HTTP CLI; only an explicit `--host` is stored on a profile. Profile state is written 0600 in 0700 directories, and directories or grant history created by older releases are tightened on the next write.

  `tc share publish` authorization hints for OpenKey profiles now name `tc --profile <name> auth login --device --manifest builtin:share-publishing` (or `tc --profile <name> enable share`), and scope denials name the `builtin:share-publishing` scope; local-key profiles keep `auth login --method local`. The packaged `tc-cli` skill requires CLI `>=1.0.0-beta.17`, the first release with these commands. Device login validates that OpenKey's relay key is a P-256 point before deriving the relay secret. `tc auth request --grant --device` keeps signed ReCap caveats on the granted resources, in the stored delegation and in the reported grant, so a caveated grant is never replayed as unrestricted.

### Patch Changes

- Updated dependencies [48eca36]
- Updated dependencies [48eca36]
  - @tinycloud/operations@0.3.3-beta.14
  - @tinycloud/node-sdk@3.0.0-beta.16

## 1.0.0-beta.16

### Patch Changes

- 2e9db6e: Owner-only (email-addressed) Share links published by the CLI now open in the Share viewer, and CLI `--to domain:` shares now work. The CLI commits the recipient's mailbox credential in the policy (Policy/v2) and publishes the owner's node location record before publishing.
  - `publishAddressedShare` refuses an exact-email share without a credential requirement bound to the address. Previously such a share was signed as Policy/v1, which no receiver accepts.
  - The new `addressedCredentialRequirement(target)` builds the commitment for email and email-domain targets.
  - The new `prepareAddressedShare(request)` runs every target, recipient, filename and action check, with no side effects. The CLI calls it before publishing the location record or uploading, so a refused share (for example `--to domain:… --action edit`) leaves nothing behind.
  - `notifyShare` matches, keys and delivers on the canonical mailbox, so `tc share publish --to email:Foo@x.com --notify` and `tc share notify --to Foo@x.com` invite `foo@x.com`. The CLI canonicalizes `--to` mailboxes and domains up front, and an invalid one reports the specific reason.
  - A location registry outage during `tc share publish` (network error, 5xx, 408 or 429) reports `UNAVAILABLE` (exit 4) with a retry hint. A registry rejection (any other 4xx, or an invalid record) reports `REGISTRY_REJECTED` (exit 6) and says that retrying will not help. sdk-core throws the new `LocationRegistryHttpError`, which carries the HTTP `status`, for registry HTTP failures; the message text is unchanged.
  - `canonicalMailbox`, `canonicalEmailDomain`, `isCanonicalEmailDomain` and `mailboxBelongsToDomain` now live in `@tinycloud/share-envelope`. `@tinycloud/sdk-core` re-exports them unchanged.

- Updated dependencies [2e9db6e]
  - @tinycloud/share-envelope@1.0.0-beta.5
  - @tinycloud/share-sdk@1.0.0-beta.7
  - @tinycloud/sdk-core@3.0.0-beta.15
  - @tinycloud/node-sdk@3.0.0-beta.15
  - @tinycloud/operations@0.3.3-beta.13

## 1.0.0-beta.15

### Patch Changes

- d8b122e: Bind restored-session share publication to the signed owner space, compare EIP-155 owner addresses without case sensitivity, classify authority failures, and constrain implicit share expiry to session lifetime.
- d8b122e: Preserve actionable sharing and KV authorization diagnostics while keeping CLI output safe and session expiry guidance prioritized.
- d8b122e: Restore backwards-compatible auth codes and preserve typed session and authorization diagnostics across SDK boundaries.
- d8b122e: Harden share publication expiry clamping and map restored-session and authorization failures to typed, safe errors.
- d8b122e: Resolve Share publication's owner space from restored OpenKey sessions while retaining the configured Share-origin binding.
- Updated dependencies [d8b122e]
- Updated dependencies [d8b122e]
- Updated dependencies [d8b122e]
- Updated dependencies [d8b122e]
  - @tinycloud/node-sdk@3.0.0-beta.14
  - @tinycloud/share-sdk@1.0.0-beta.6
  - @tinycloud/operations@0.3.3-beta.12

## 1.0.0-beta.14

### Patch Changes

- Updated dependencies [036ce34]
  - @tinycloud/node-sdk@3.0.0-beta.13
  - @tinycloud/operations@0.3.3-beta.11

## 1.0.0-beta.13

### Patch Changes

- Updated dependencies [cc27c3a]
  - @tinycloud/share-sdk@1.0.0-beta.5
  - @tinycloud/node-sdk@3.0.0-beta.12
  - @tinycloud/operations@0.3.3-beta.10

## 1.0.0-beta.12

### Patch Changes

- @tinycloud/node-sdk@3.0.0-beta.11
- @tinycloud/operations@0.3.3-beta.9

## 1.0.0-beta.11

### Major Changes

- b852650: Seal Policy/v3 recipient metadata as the canonical AES-256-GCM
  `version || nonce || ciphertext+tag` blob before constructing an addressed
  share link. Delivery authorization now binds that sealed blob and its
  fragment-only key, rather than accepting a plaintext `?tc2` envelope. Remove
  the public plaintext Policy/v3 inline URL codec; only sealed fragment links
  are accepted for addressed shares. Add the reusable app-neutral
  OpenCredentials invitation client and bind notification retries to the signed
  delivery JTI/nonce used by Node and OpenCredentials deduplication.

### Patch Changes

- Updated dependencies [b852650]
  - @tinycloud/share-envelope@1.0.0-beta.4
  - @tinycloud/share-sdk@1.0.0-beta.4
  - @tinycloud/node-sdk@3.0.0-beta.10
  - @tinycloud/operations@0.3.3-beta.8

## 1.0.0-beta.10

### Major Changes

- c690844: Complete the TC-498/TC-500 native-sharing beta cutover. The legacy
  broker-backed Share APIs, link/transport compatibility paths, and retired CLI
  Share flags are intentionally removed. Use owner-Node native bearer
  delegations or signed Policy/v3 addressed shares; this release does not retain
  a parallel legacy broker authority plane.

### Patch Changes

- c690844: Reject addressed-share ciphertext whose exact owner-KV bytes do not match the
  signed source digest before key unwrap or rendering. Revoke addressed shares
  through the existing signed Policy/v3 root-revocation path, which cuts off
  active sessions as well as fresh admission and delivery.
- Updated dependencies [c690844]
- Updated dependencies [c690844]
  - @tinycloud/share-envelope@1.0.0-beta.3
  - @tinycloud/share-sdk@1.0.0-beta.3
  - @tinycloud/node-sdk@3.0.0-beta.9
  - @tinycloud/operations@0.3.3-beta.7

## 0.9.1-beta.9

### Patch Changes

- Updated dependencies [46c83a7]
  - @tinycloud/node-sdk@3.0.0-beta.8
  - @tinycloud/operations@0.3.3-beta.6

## 0.9.1-beta.8

### Patch Changes

- Updated dependencies [026bf15]
  - @tinycloud/share-sdk@0.3.0-beta.2
  - @tinycloud/share-envelope@0.2.1-beta.2
  - @tinycloud/node-sdk@3.0.0-beta.7
  - @tinycloud/operations@0.3.3-beta.5

## 0.9.1-beta.7

### Patch Changes

- 08f5bad: Route hosted Share device authorization through the canonical OpenKey API origin while preserving the browser approval origin and explicit self-hosted overrides.

## 0.9.1-beta.6

### Patch Changes

- aee2308: Add Share-first, end-to-end-encrypted OpenKey device authorization for first-time remote publishing, plus explicit `tc auth login --device` and `tc enable share` commands.

## 0.9.1-beta.5

### Patch Changes

- 9cc11ca: Honor Share subcommands' `--json` flag when the root CLI also defines that option, restoring machine-readable success output for inspect, receive, and lifecycle commands.

## 0.9.1-beta.4

### Patch Changes

- Updated dependencies [31043b5]
  - @tinycloud/node-sdk@3.0.0-beta.6
  - @tinycloud/operations@0.3.3-beta.4

## 0.9.1-beta.3

### Patch Changes

- Updated dependencies [dc92402]
  - @tinycloud/share-envelope@0.2.1-beta.1
  - @tinycloud/share-sdk@0.3.0-beta.1
  - @tinycloud/node-sdk@3.0.0-beta.5
  - @tinycloud/operations@0.3.3-beta.3

## 0.9.1-beta.2

### Patch Changes

- Updated dependencies [b0069f7]
  - @tinycloud/share-sdk@0.3.0-beta.0
  - @tinycloud/share-envelope@0.2.1-beta.0
  - @tinycloud/node-sdk@3.0.0-beta.2
  - @tinycloud/operations@0.3.3-beta.2

## 0.9.1-beta.1

### Patch Changes

- @tinycloud/node-sdk@3.0.0-beta.1
- @tinycloud/operations@0.3.3-beta.1

## 0.9.1-beta.0

### Patch Changes

- @tinycloud/node-sdk@3.0.0-beta.0
- @tinycloud/operations@0.3.3-beta.0

## 0.9.0

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

- 2a77ebc: Add bounded Markdown bearer publishing plus stdin-safe Share inspect and receive commands backed by the canonical headless SDK.
- 4ce36a6: Add typed recipient-DID/device authorization, exact-email and domain policy publication/claim resume seams, idempotent notification outcomes, encrypted sender history views, target-aware revocation, and explicit read-only tc1 migration helpers to the canonical Share SDK and CLI.

### Patch Changes

- 746cb02: Stop implicitly probing `127.0.0.1` during TinyCloud host discovery. Loopback
  discovery now requires an explicit `localNodeUrl`, while configured and
  registry-discovered `*.local.tinycloud.link` nodes continue to work.
- 44ecf56: Release the exact-head session invocation APIs and canonical recipient-DID policy support used by Share.
- 17d5662: Pin addressed verification to an injected signer trust root, require detached node proof verification for authorized content, and keep Share command authority seams explicit and redacted.
- 705685e: Keep Share machine output redacted, make unavailable addressed revocation fail
  non-zero, and route browser consumers through the compiled receive contract.
- 07e3c85: Add an explicit read-only `share migrate` bridge for `tc1:` links and expose
  authenticated Share upload adapters to the modern CLI publisher.
- d4ec80a: Harden addressed Share content verification, restore CLI command dispatch and
  nonce-bound production upload authorization, and close filesystem and lifecycle
  edge cases in the Share command surface.
- 1103359: Route addressed Share verification through the canonical SDK, keep Node uploads fail-closed without explicit authority, and make the Share/help CLI entry independent of optional WASM authentication modules.
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

- Updated dependencies [746cb02]
- Updated dependencies [d1d675b]
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
- Updated dependencies [a7e3668]
- Updated dependencies [e525137]
- Updated dependencies [ba9c983]
- Updated dependencies [f0842d8]
- Updated dependencies [d894c57]
- Updated dependencies [7805213]
  - @tinycloud/node-sdk@2.11.0
  - @tinycloud/operations@0.3.2
  - @tinycloud/node-sdk-wasm@1.7.6
  - @tinycloud/share-sdk@0.2.0
  - @tinycloud/share-envelope@0.2.0

## 0.9.0-beta.11

### Patch Changes

- Updated dependencies [7805213]
  - @tinycloud/share-envelope@0.2.0-beta.1
  - @tinycloud/share-sdk@0.2.0-beta.2
  - @tinycloud/node-sdk@2.11.0-beta.12
  - @tinycloud/operations@0.3.2-beta.11

## 0.9.0-beta.10

### Patch Changes

- Updated dependencies [d894c57]
  - @tinycloud/node-sdk@2.11.0-beta.11
  - @tinycloud/operations@0.3.2-beta.10

## 0.9.0-beta.9

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

- Updated dependencies [b38dd12]
- Updated dependencies [cc75957]
- Updated dependencies [a7e3668]
- Updated dependencies [e525137]
- Updated dependencies [ba9c983]
  - @tinycloud/node-sdk@2.11.0-beta.10
  - @tinycloud/operations@0.3.2-beta.9

## 0.9.0-beta.8

### Patch Changes

- @tinycloud/node-sdk@2.11.0-beta.9
- @tinycloud/operations@0.3.2-beta.8

## 0.9.0-beta.7

### Patch Changes

- Updated dependencies [68faad4]
  - @tinycloud/node-sdk-wasm@1.7.6-beta.0
  - @tinycloud/node-sdk@2.11.0-beta.8
  - @tinycloud/operations@0.3.2-beta.7

## 0.9.0-beta.6

### Minor Changes

- 2a77ebc: Add bounded Markdown bearer publishing plus stdin-safe Share inspect and receive commands backed by the canonical headless SDK.
- 4ce36a6: Add typed recipient-DID/device authorization, exact-email and domain policy publication/claim resume seams, idempotent notification outcomes, encrypted sender history views, target-aware revocation, and explicit read-only tc1 migration helpers to the canonical Share SDK and CLI.

### Patch Changes

- 44ecf56: Release the exact-head session invocation APIs and canonical recipient-DID policy support used by Share.
- 17d5662: Pin addressed verification to an injected signer trust root, require detached node proof verification for authorized content, and keep Share command authority seams explicit and redacted.
- 705685e: Keep Share machine output redacted, make unavailable addressed revocation fail
  non-zero, and route browser consumers through the compiled receive contract.
- 07e3c85: Add an explicit read-only `share migrate` bridge for `tc1:` links and expose
  authenticated Share upload adapters to the modern CLI publisher.
- d4ec80a: Harden addressed Share content verification, restore CLI command dispatch and
  nonce-bound production upload authorization, and close filesystem and lifecycle
  edge cases in the Share command surface.
- 1103359: Route addressed Share verification through the canonical SDK, keep Node uploads fail-closed without explicit authority, and make the Share/help CLI entry independent of optional WASM authentication modules.
- Updated dependencies [44ecf56]
- Updated dependencies [17d5662]
- Updated dependencies [2a77ebc]
- Updated dependencies [705685e]
- Updated dependencies [d4ec80a]
- Updated dependencies [1103359]
- Updated dependencies [9fd8752]
- Updated dependencies [4ce36a6]
  - @tinycloud/node-sdk@2.11.0-beta.7
  - @tinycloud/operations@0.3.2-beta.6
  - @tinycloud/share-sdk@0.2.0-beta.0
  - @tinycloud/share-envelope@0.2.0-beta.0

## 0.8.3-beta.4

### Patch Changes

- Updated dependencies [f0842d8]
  - @tinycloud/node-sdk@2.11.0-beta.5
  - @tinycloud/operations@0.3.2-beta.4

## 0.8.3-beta.3

### Patch Changes

- 746cb02: Stop implicitly probing `127.0.0.1` during TinyCloud host discovery. Loopback
  discovery now requires an explicit `localNodeUrl`, while configured and
  registry-discovered `*.local.tinycloud.link` nodes continue to work.
- Updated dependencies [746cb02]
  - @tinycloud/node-sdk@2.11.0-beta.4
  - @tinycloud/operations@0.3.2-beta.3

## 0.8.3-beta.2

### Patch Changes

- @tinycloud/node-sdk@2.11.0-beta.3
- @tinycloud/operations@0.3.2-beta.2

## 0.8.3-beta.1

### Patch Changes

- Updated dependencies [d1d675b]
  - @tinycloud/node-sdk@2.11.0-beta.1
  - @tinycloud/operations@0.3.2-beta.1

## 0.8.3-beta.0

### Patch Changes

- @tinycloud/node-sdk@2.11.0-beta.0
- @tinycloud/operations@0.3.2-beta.0

## 0.8.2

### Patch Changes

- Updated dependencies [28cc430]
  - @tinycloud/node-sdk@2.10.0
  - @tinycloud/operations@0.3.1

## 0.8.2-beta.1

### Patch Changes

- @tinycloud/node-sdk@2.10.0-beta.1
- @tinycloud/operations@0.3.1-beta.1

## 0.8.2-beta.0

### Patch Changes

- Updated dependencies [28cc430]
  - @tinycloud/node-sdk@2.10.0-beta.0
  - @tinycloud/operations@0.3.1-beta.0

## 0.8.1

### Patch Changes

- Updated dependencies [f0febf1]
  - @tinycloud/operations@0.3.0

## 0.8.1-beta.0

### Patch Changes

- Updated dependencies [f0febf1]
  - @tinycloud/operations@0.3.0-beta.0

## 0.8.0

### Minor Changes

- 9afb09c: Add localhost-first node resolution with identity pinning. Before falling back to registry/hosted resolution, `resolveTinyCloudHosts` now probes for a locally-running TinyCloud node (loopback, then `*.local.tinycloud.link`) and uses it if it answers and passes DID identity verification (trust-on-first-use, pinned per consumer). New opt-out and config knobs: `autoDiscoverLocalNode` (default true), `localNodeUrl`, `localLinkName`, `expectedNodeDid`, surfaced on node-sdk, web-sdk, and the CLI. Explicit host configuration (`host`, `--host`/`TC_HOST`) continues to skip discovery entirely.

### Patch Changes

- Updated dependencies [9afb09c]
  - @tinycloud/node-sdk@2.9.0
  - @tinycloud/operations@0.2.1

## 0.7.8

### Patch Changes

- Updated dependencies [7ecd455]
- Updated dependencies [7ecd455]
  - @tinycloud/operations@0.2.0
  - @tinycloud/node-sdk@2.8.0

## 0.7.8-beta.0

### Patch Changes

- Updated dependencies [7ecd455]
- Updated dependencies [7ecd455]
  - @tinycloud/operations@0.2.0-beta.0
  - @tinycloud/node-sdk@2.8.0-beta.0

## 0.7.7

### Patch Changes

- 1269a58: Add canonical delegated account-space, application, and generic non-secrets KV exploration operations. Publish the beta MCP package with four corresponding read-only tools and a documented exact request, owner grant, import, restart, and retry workflow. Allow a fresh delegate profile to bootstrap from its first request-bound delegation while preserving canonical import validation.
- 565b5fd: Reject unrecoverable public-only profile sessions before SDK restore and report missing private JWK material as an authentication problem with a sign-in hint instead of a network failure.
- 28e4ae8: Allow a fresh `delegate-session` profile to request permissions using logical space names before it knows the granting owner's address.
- 5c32147: Add the I5 Commander coverage ledger and deterministic registration check,
  cross-surface canonical-envelope fixtures, generated coverage references,
  source-boundary checks, and Node 20 packed-artifact conformance gates. MCP
  publication remains deferred while the SDK v2 beta gate is `unpublishable-defer`.
- a5b557a: Resolve explicit-key secret spaces against the authenticated owner and keep
  local-owner acquisition and its single retry on one live runtime session.
- 2721f9d: Add the experimental operations package foundation and depend on its exact prerelease from the CLI.
- f5b1c75: Repair I2 release artifacts: bundle ESM-only multiformats dependencies for Node CommonJS consumers, preserve safe delegation mismatch details, and publish the canonical CLI auth import route.
- b982b90: Declare Node 20 or newer as the supported runtime floor for the complete published SDK and Operations graph, including the CLI and Node WASM bindings.
- 206533a: Route request-bound v1 delegation imports through TinyCloud operations while retaining legacy auth-import compatibility paths.
- abe8083: Implement the canonical `tinycloud.secrets.get` operation and route `tc secrets get` through it while preserving Commander rendering and owner authorization behavior.
- decbb25: Allow a fresh `delegate-session` profile to establish its first authenticated session by importing a delegation targeted at its generated session key.
- Updated dependencies [492a656]
- Updated dependencies [940ff1d]
- Updated dependencies [367c17c]
- Updated dependencies [1269a58]
- Updated dependencies [5172cf9]
- Updated dependencies [f6048b7]
- Updated dependencies [5c32147]
- Updated dependencies [a5b557a]
- Updated dependencies [2721f9d]
- Updated dependencies [f7a1d4f]
- Updated dependencies [f5b1c75]
- Updated dependencies [39cc055]
- Updated dependencies [4dee0a9]
- Updated dependencies [b982b90]
- Updated dependencies [96b9e21]
- Updated dependencies [160c16e]
- Updated dependencies [d6d5ef1]
- Updated dependencies [8777823]
- Updated dependencies [abe8083]
- Updated dependencies [cd8c11f]
- Updated dependencies [1606a6f]
- Updated dependencies [c62f72a]
- Updated dependencies [1c73181]
- Updated dependencies [96b9e21]
  - @tinycloud/operations@0.1.0
  - @tinycloud/node-sdk-wasm@1.7.5
  - @tinycloud/node-sdk@2.7.0

## 0.7.7-beta.8

### Patch Changes

- 1269a58: Add canonical delegated account-space, application, and generic non-secrets KV exploration operations. Publish the beta MCP package with four corresponding read-only tools and a documented exact request, owner grant, import, restart, and retry workflow. Allow a fresh delegate profile to bootstrap from its first request-bound delegation while preserving canonical import validation.
- Updated dependencies [1269a58]
  - @tinycloud/operations@0.1.0-beta.2
  - @tinycloud/node-sdk@2.7.0-beta.5

## 0.7.7-beta.7

### Patch Changes

- 5c32147: Add the I5 Commander coverage ledger and deterministic registration check,
  cross-surface canonical-envelope fixtures, generated coverage references,
  source-boundary checks, and Node 20 packed-artifact conformance gates. MCP
  publication remains deferred while the SDK v2 beta gate is `unpublishable-defer`.
- a5b557a: Resolve explicit-key secret spaces against the authenticated owner and keep
  local-owner acquisition and its single retry on one live runtime session.
- 2721f9d: Add the experimental operations package foundation and depend on its exact prerelease from the CLI.
- f5b1c75: Repair I2 release artifacts: bundle ESM-only multiformats dependencies for Node CommonJS consumers, preserve safe delegation mismatch details, and publish the canonical CLI auth import route.
- b982b90: Declare Node 20 or newer as the supported runtime floor for the complete published SDK and Operations graph, including the CLI and Node WASM bindings.
- 206533a: Route request-bound v1 delegation imports through TinyCloud operations while retaining legacy auth-import compatibility paths.
- abe8083: Implement the canonical `tinycloud.secrets.get` operation and route `tc secrets get` through it while preserving Commander rendering and owner authorization behavior.
- Updated dependencies [492a656]
- Updated dependencies [940ff1d]
- Updated dependencies [5172cf9]
- Updated dependencies [5c32147]
- Updated dependencies [a5b557a]
- Updated dependencies [2721f9d]
- Updated dependencies [f5b1c75]
- Updated dependencies [39cc055]
- Updated dependencies [b982b90]
- Updated dependencies [96b9e21]
- Updated dependencies [160c16e]
- Updated dependencies [d6d5ef1]
- Updated dependencies [8777823]
- Updated dependencies [abe8083]
- Updated dependencies [cd8c11f]
- Updated dependencies [1606a6f]
- Updated dependencies [c62f72a]
- Updated dependencies [1c73181]
- Updated dependencies [96b9e21]
  - @tinycloud/operations@0.1.0-beta.1
  - @tinycloud/node-sdk-wasm@1.7.5-beta.0
  - @tinycloud/node-sdk@2.7.0-beta.4

## 0.7.7-beta.6

### Patch Changes

- Updated dependencies [f7a1d4f]
  - @tinycloud/node-sdk@2.7.0-beta.3

## 0.7.7-beta.5

### Patch Changes

- Updated dependencies [4dee0a9]
  - @tinycloud/node-sdk@2.7.0-beta.2

## 0.7.7-beta.4

### Patch Changes

- 28e4ae8: Allow a fresh `delegate-session` profile to request permissions using logical space names before it knows the granting owner's address.

## 0.7.7-beta.3

### Patch Changes

- decbb25: Allow a fresh `delegate-session` profile to establish its first authenticated session by importing a delegation targeted at its generated session key.

## 0.7.7-beta.2

### Patch Changes

- Updated dependencies [367c17c]
  - @tinycloud/node-sdk@2.6.4-beta.1

## 0.7.7-beta.1

### Patch Changes

- 565b5fd: Reject unrecoverable public-only profile sessions before SDK restore and report missing private JWK material as an authentication problem with a sign-in hint instead of a network failure.

## 0.7.7-beta.0

### Patch Changes

- Updated dependencies [f6048b7]
  - @tinycloud/node-sdk@2.6.4-beta.0

## 0.7.6

### Patch Changes

- Updated dependencies [3841be4]
  - @tinycloud/node-sdk@2.6.3

## 0.7.6-beta.0

### Patch Changes

- Updated dependencies [3841be4]
  - @tinycloud/node-sdk@2.6.3-beta.0

## 0.7.5

### Patch Changes

- Updated dependencies [b4d1e45]
  - @tinycloud/node-sdk@2.6.2

## 0.7.5-beta.0

### Patch Changes

- Updated dependencies [b4d1e45]
  - @tinycloud/node-sdk@2.6.2-beta.0

## 0.7.4

### Patch Changes

- Updated dependencies [bf31506]
  - @tinycloud/node-sdk@2.6.1

## 0.7.4-beta.1

### Patch Changes

- @tinycloud/node-sdk@2.6.1-beta.1

## 0.7.4-beta.0

### Patch Changes

- Updated dependencies [bf31506]
  - @tinycloud/node-sdk@2.6.1-beta.0

## 0.7.3

### Patch Changes

- Updated dependencies [ac48f85]
- Updated dependencies [2f31800]
- Updated dependencies [3ad0635]
- Updated dependencies [e07823b]
  - @tinycloud/node-sdk@2.6.0

## 0.7.3-beta.3

### Patch Changes

- Updated dependencies [e07823b]
  - @tinycloud/node-sdk@2.6.0-beta.3

## 0.7.3-beta.2

### Patch Changes

- Updated dependencies [3ad0635]
  - @tinycloud/node-sdk@2.6.0-beta.2

## 0.7.3-beta.1

### Patch Changes

- Updated dependencies [ac48f85]
  - @tinycloud/node-sdk@2.6.0-beta.1

## 0.7.3-beta.0

### Patch Changes

- Updated dependencies [2f31800]
  - @tinycloud/node-sdk@2.6.0-beta.0

## 0.7.2

### Patch Changes

- Updated dependencies [3b23940]
  - @tinycloud/node-sdk@2.5.1

## 0.7.2-beta.0

### Patch Changes

- Updated dependencies [3b23940]
  - @tinycloud/node-sdk@2.5.1-beta.0

## 0.7.1

### Patch Changes

- Updated dependencies [cbd5dcc]
- Updated dependencies [dda499e]
  - @tinycloud/node-sdk@2.5.0

## 0.7.1-beta.1

### Patch Changes

- Updated dependencies [dda499e]
  - @tinycloud/node-sdk@2.5.0-beta.1

## 0.7.1-beta.0

### Patch Changes

- Updated dependencies [cbd5dcc]
  - @tinycloud/node-sdk@2.4.1-beta.0

## 0.7.0

### Minor Changes

- 6b554d6: Add shared account APIs for applications and delegations, expose them from the node and web SDK clients, and add the `tc account` CLI command group.
- 75bebb1: Add account registry write-through indexing, account space registry APIs, and matching `tc account spaces` / `tc account index status` CLI commands.

  Manifest registration now records an indexed manifest hash and skips durable KV rewrites when the indexed record is current. Sign-in schedules best-effort background registry sync for application manifests and accessible spaces, while every discovered or hosted space is written through to the account registry index.

- 0e8ccc6: Add `TinyCloudNode.hostOwnedSpace(name)` and wire `tc space create`/`tc space host` to it.

  Hosting an owned space (e.g. `applications`) by name now registers it on the server via the host-SIWE delegation flow, so subsequent KV/SQL writes to that space succeed instead of returning `404 - Space not found`. Unlike the internal `ensureOwnedSpaceHosted`, this always submits the host delegation rather than inferring hosting from session activation — a space the current session has never referenced is reported neither `activated` nor `skipped`, which previously caused the host to be silently skipped. The host SIWE is idempotent server-side, so re-hosting an existing space is a safe no-op.

  The `tc space create <name>` command (which previously POSTed the unsupported `tinycloud.space/create` action and failed with `401 Unauthorized`) now hosts the caller's owned space; `tc space host <name>` is added as an alias.

- 934534d: Auth/hosting developer experience for the delegate-asks-owner-to-host model.
  - **`tc space host-request <name> --emit <file>`** (delegate-only): emits a `tinycloud.host.request` artifact naming the space and its resolved owner DID so an agent can surface it to the owner, who then runs `tc space host <name>`. If the caller IS the root authority of the resolved space, it refuses (`ALREADY_ROOT_AUTHORITY`) and tells them to host directly — no request is emitted. The command is a pure local emit and never contacts the node.
  - **Identity-aware `SPACE_NOT_HOSTED`**: an unhosted-space write/read previously surfaced as an opaque `404 - Space not found`. The kv and sql commands now normalize **only** that exact condition (404 + "Space not found" body) to a `SPACE_NOT_HOSTED` error carrying an identity-aware `hint`. The branch key `is_root_authority(space, active session)` is computed locally from the profile address + space DID (no network): the owner is told to run `tc space host <name>`, a delegate is told they cannot host and to emit `tc space host-request <name> --emit`. A wrong db/table/path or permission error is left untouched. A `delegate-session` profile is never treated as the root authority even when its stored ownerDid is the space owner, so a delegate always gets the host-request hint. `KVService` get/head/delete now preserve the `Space not found` 404 body (previously collapsed to `KV_NOT_FOUND` before the body was read), so unhosted-space **reads** normalize too, while a genuine missing key still reports `KV_NOT_FOUND`.
  - **SDK `grantAuthRequest(authority, request, options?)`** (`@tinycloud/node-sdk`): takes a delegation request artifact and returns a grant artifact (`tinycloud.auth.delegation`) by signing through `delegateTo`, so the request→grant handshake is callable programmatically. `tc auth grant` is now a thin wrapper over it. Adds the `AuthRequestArtifact`, `AuthDelegationArtifact`, and `DelegationAuthority` types.

- 5737b67: Add `tc secrets get <NAME> --delegation <file-or-imported-profile>` for reading a secret you were delegated access to. The `--delegation` source can be a delegation JSON file or the name of a profile that imported the delegation (resolved from `additional-delegations.json`). The read path validates that the delegation covers both the secret's `tinycloud.kv/get` path and the envelope's `tinycloud.encryption/decrypt` network, then activates the delegation in wallet mode via `node.useDelegation(...)` to fetch and decrypt the value. Adds a `smoke:delegated-secrets` script that exercises the full owner-delegate flow against a live node.
- 1f69109: `tc secrets {get,put,delete,list,doctor}` now targets the literal `secrets` space (matching the secret-manager web app's `SECRETS_SPACE` in `src/lib/tinycloud-manifest.ts`) instead of the active profile's default space, so CLI-issued permission grants line up with secrets stored by the web app. Restores `--space <space>` as a real flag distinct from `--scope <scope>` (previously `--space` was a silent alias for `--scope`); `--space` overrides the permission-grant space. Permission paths remain `vault/secrets/<NAME>` / `vault/secrets/scoped/<scope>/<NAME>` — the `vault/` prefix is the wire-level KV path that `DataVaultService` writes to and that `tinycloud.vault` permissions expand to via `vaultActionExpansion()` in `sdk-core`, not a CLI-only artifact.

  Known limitation: `--space` currently only flows through to permission-grant requests; the underlying `node.secrets.{get,put,delete,list}` calls still resolve their own space via the SDK. Lighting `--space` up end-to-end requires SDK work outside this CLI package.

### Patch Changes

- 0d397a8: Treat the account SQLite index as a materialized cache for user-facing account reads. Account application, space, and delegation list calls can now prefer the index while falling back to canonical account data when index tables are missing or empty, and account writes no longer fail when a best-effort index update fails.
- 6622043: Expose `account.index.ensure()` and `tc account index ensure` for lightweight account SQLite schema bootstrap, and start schema bootstrap with background account registry sync.
- 5737b67: Fix `tc auth import` rejecting cross-user delegations. Import unconditionally called `node.useRuntimeDelegation(...)`, which requires the delegation to target the active session key and so threw `Runtime delegation targets did:pkh:... but this session key is did:key:...` for a delegation received from another user (audience = your stable identity DID). Import now routes by audience: a delegation that targets the active session key is still installed as a runtime grant, while a cross-user delegation is persisted to `additional-delegations.json` and later activated at read time via `node.useDelegation(...)`. The `imported` output now includes an `activated` flag indicating whether a runtime grant was installed.
- a61f935: Delegate-mode secrets commands now honor `TC_PRIVATE_KEY` / `--private-key` for headless auth. Previously `tc secrets get --delegation` (and the other `--private-key`-advertising secrets commands) threw `AUTH_REQUIRED` when only an explicit private key was supplied, because `ensureAuthenticated` consulted `options.privateKey` only after its profile/session gate. An explicitly provided private key is now treated as a first-class headless identity and accepted before that gate, so a delegate can authenticate with no persisted profile and no login session — exactly what the flags and env var already advertised.
- 0219c37: Fix `tc kv` and `tc sql` failing with `Missing private key parameter in JWK` after an OpenKey login. The OpenKey delegation flow sends only the public JWK (no `d`) to OpenKey, and the public-only JWK that OpenKey echoes back was being persisted verbatim to `session.json`, shadowing the full keypair in `key.json` whenever the SDK reconstructed the WASM signer. Two-pronged fix: (1) on read, `sdk.ts` falls back to `key.json` whenever `session.jwk` lacks the `d` parameter, and (2) on write, `refreshOpenKeySession` merges `d` from `key.json` into the persisted session JWK so future invocations don't hit the same path. `tc auth status` and `tc secrets get` were unaffected because neither hits the WASM signer in this code path.

  Affected users on existing installs can unblock without re-authenticating by jq-merging `key.json`'s `d` into `session.json`'s `.jwk` field.

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

- 7603d1f: Support concise app manifest knowledge pointers. The SDK now validates `knowledge: true` and `knowledge/*.md` roots, exposes a helper for resolving the effective knowledge root, and `tc manifest resolve` includes that root in its output.
- cdcb227: Send a user-facing `reason` when TinyCloud CLI opens OpenKey permission approval flows, so the consent page can show why the requested capabilities are needed.
- 0187e64: Fix `OPENKEY_SCOPE_MISMATCH` on `tc auth request --grant` for OpenKey profiles, and batch multiple `--cap` on one space into a single OpenKey round-trip.

  The CLI compared the space the OpenKey node returned against the space it built for the request byte-for-byte. OpenKey returns the EIP-55 **checksummed** eip155 address (`0xd559CCd9...dE93cf412`) while the CLI builds the **lowercase** form, so a grant for a valid space spuriously failed with `OPENKEY_SCOPE_MISMATCH`. Ethereum addresses are case-insensitive; space comparison now normalizes (lowercases) the address segment on both sides.

  The same normalization is applied when grouping requested caps by space, so multiple `--cap` for the same space — even if one is typed checksummed and another lowercase — batch into a single OpenKey browser round-trip instead of one per casing.

- e2c3bb1: Add `tc secrets doctor` and include default secrets decrypt permissions when app manifests request readable secrets.
- a22a7f0: Rename the SDK-emitted SQL schema-change permission from `tinycloud.sql/ddl` to `tinycloud.sql/schema`, including manifest defaults and account-registry grants.

  TinyCloudWeb now treats a restored persisted session as stale when it does not cover the currently configured manifest permissions, then runs the normal manifest sign-in flow instead of letting apps request those manifest permissions separately after login.

- Updated dependencies [6b554d6]
- Updated dependencies [0d397a8]
- Updated dependencies [895804a]
- Updated dependencies [6622043]
- Updated dependencies [75bebb1]
- Updated dependencies [0e8ccc6]
- Updated dependencies [934534d]
- Updated dependencies [79dd26c]
- Updated dependencies [08e292d]
- Updated dependencies [7c5fe21]
- Updated dependencies [eb44380]
- Updated dependencies [27f97d8]
- Updated dependencies [aa050d1]
- Updated dependencies [8e8f7e8]
- Updated dependencies [fa4a7c7]
- Updated dependencies [d4a0a69]
- Updated dependencies [a22a7f0]
- Updated dependencies [42f1235]
- Updated dependencies [b6c3fd8]
  - @tinycloud/node-sdk@2.4.0

## 0.7.0-beta.23

### Minor Changes

- 1f69109: `tc secrets {get,put,delete,list,doctor}` now targets the literal `secrets` space (matching the secret-manager web app's `SECRETS_SPACE` in `src/lib/tinycloud-manifest.ts`) instead of the active profile's default space, so CLI-issued permission grants line up with secrets stored by the web app. Restores `--space <space>` as a real flag distinct from `--scope <scope>` (previously `--space` was a silent alias for `--scope`); `--space` overrides the permission-grant space. Permission paths remain `vault/secrets/<NAME>` / `vault/secrets/scoped/<scope>/<NAME>` — the `vault/` prefix is the wire-level KV path that `DataVaultService` writes to and that `tinycloud.vault` permissions expand to via `vaultActionExpansion()` in `sdk-core`, not a CLI-only artifact.

  Known limitation: `--space` currently only flows through to permission-grant requests; the underlying `node.secrets.{get,put,delete,list}` calls still resolve their own space via the SDK. Lighting `--space` up end-to-end requires SDK work outside this CLI package.

### Patch Changes

- 0219c37: Fix `tc kv` and `tc sql` failing with `Missing private key parameter in JWK` after an OpenKey login. The OpenKey delegation flow sends only the public JWK (no `d`) to OpenKey, and the public-only JWK that OpenKey echoes back was being persisted verbatim to `session.json`, shadowing the full keypair in `key.json` whenever the SDK reconstructed the WASM signer. Two-pronged fix: (1) on read, `sdk.ts` falls back to `key.json` whenever `session.jwk` lacks the `d` parameter, and (2) on write, `refreshOpenKeySession` merges `d` from `key.json` into the persisted session JWK so future invocations don't hit the same path. `tc auth status` and `tc secrets get` were unaffected because neither hits the WASM signer in this code path.

  Affected users on existing installs can unblock without re-authenticating by jq-merging `key.json`'s `d` into `session.json`'s `.jwk` field.

## 0.7.0-beta.22

### Patch Changes

- Updated dependencies [42f1235]
  - @tinycloud/node-sdk@2.4.0-beta.19

## 0.7.0-beta.21

### Patch Changes

- a61f935: Delegate-mode secrets commands now honor `TC_PRIVATE_KEY` / `--private-key` for headless auth. Previously `tc secrets get --delegation` (and the other `--private-key`-advertising secrets commands) threw `AUTH_REQUIRED` when only an explicit private key was supplied, because `ensureAuthenticated` consulted `options.privateKey` only after its profile/session gate. An explicitly provided private key is now treated as a first-class headless identity and accepted before that gate, so a delegate can authenticate with no persisted profile and no login session — exactly what the flags and env var already advertised.

## 0.7.0-beta.20

### Patch Changes

- Updated dependencies [08e292d]
  - @tinycloud/node-sdk@2.4.0-beta.18

## 0.7.0-beta.19

### Patch Changes

- 6622043: Expose `account.index.ensure()` and `tc account index ensure` for lightweight account SQLite schema bootstrap, and start schema bootstrap with background account registry sync.
- Updated dependencies [6622043]
  - @tinycloud/node-sdk@2.4.0-beta.17

## 0.7.0-beta.18

### Patch Changes

- Updated dependencies [eb44380]
  - @tinycloud/node-sdk@2.4.0-beta.16

## 0.7.0-beta.17

### Patch Changes

- bd8a60f: Remove the deprecated `SQLAction.DDL` export and the `tinycloud.sql/ddl` permission display path. SQL schema changes use `SQLAction.SCHEMA` and `tinycloud.sql/schema`.
  - @tinycloud/node-sdk@2.4.0-beta.15

## 0.7.0-beta.16

### Patch Changes

- a22a7f0: Rename the SDK-emitted SQL schema-change permission from `tinycloud.sql/ddl` to `tinycloud.sql/schema`, including manifest defaults and account-registry grants.

  TinyCloudWeb now treats a restored persisted session as stale when it does not cover the currently configured manifest permissions, then runs the normal manifest sign-in flow instead of letting apps request those manifest permissions separately after login.

- Updated dependencies [a22a7f0]
  - @tinycloud/node-sdk@2.4.0-beta.14

## 0.7.0-beta.15

### Patch Changes

- 7603d1f: Support concise app manifest knowledge pointers. The SDK now validates `knowledge: true` and `knowledge/*.md` roots, exposes a helper for resolving the effective knowledge root, and `tc manifest resolve` includes that root in its output.
  - @tinycloud/node-sdk@2.4.0-beta.13

## 0.7.0-beta.14

### Patch Changes

- Updated dependencies [fa4a7c7]
  - @tinycloud/node-sdk@2.4.0-beta.12

## 0.7.0-beta.13

### Patch Changes

- Updated dependencies [aa050d1]
  - @tinycloud/node-sdk@2.4.0-beta.11

## 0.7.0-beta.12

### Patch Changes

- Updated dependencies [27f97d8]
- Updated dependencies [d4a0a69]
  - @tinycloud/node-sdk@2.4.0-beta.10

## 0.7.0-beta.11

### Patch Changes

- 0d397a8: Treat the account SQLite index as a materialized cache for user-facing account reads. Account application, space, and delegation list calls can now prefer the index while falling back to canonical account data when index tables are missing or empty, and account writes no longer fail when a best-effort index update fails.
- Updated dependencies [0d397a8]
  - @tinycloud/node-sdk@2.4.0-beta.9

## 0.7.0-beta.10

### Patch Changes

- Updated dependencies [895804a]
  - @tinycloud/node-sdk@2.4.0-beta.8

## 0.7.0-beta.9

### Minor Changes

- 75bebb1: Add account registry write-through indexing, account space registry APIs, and matching `tc account spaces` / `tc account index status` CLI commands.

  Manifest registration now records an indexed manifest hash and skips durable KV rewrites when the indexed record is current. Sign-in schedules best-effort background registry sync for application manifests and accessible spaces, while every discovered or hosted space is written through to the account registry index.

### Patch Changes

- cdcb227: Send a user-facing `reason` when TinyCloud CLI opens OpenKey permission approval flows, so the consent page can show why the requested capabilities are needed.
- Updated dependencies [75bebb1]
  - @tinycloud/node-sdk@2.4.0-beta.7

## 0.7.0-beta.8

### Minor Changes

- 6b554d6: Add shared account APIs for applications and delegations, expose them from the node and web SDK clients, and add the `tc account` CLI command group.

### Patch Changes

- Updated dependencies [6b554d6]
  - @tinycloud/node-sdk@2.4.0-beta.6

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
