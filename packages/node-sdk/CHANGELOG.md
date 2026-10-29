# @tinycloudlabs/node-sdk

## 3.8.0-beta.21

### Patch Changes

- 9fb359a: Allow explicit runtime permission requests to create one exact `share/<id>` named key on the current owner's default encryption network. Validate the owner, resource and action before consent, bind approval to the same signed session, and activate only the requested key-create authority. Native shells without a supported permission-request path refuse rather than falling back to a web signer. Static manifests and native authority ceilings are unchanged.

  Keep runtime permission approval bound to the captured session key through signing and activation.

  Details: TC-2192

- 9fb359a: Create a fresh, independently named session key for each Node authorization sign-in, preserving earlier session bindings and the default key even when sign-ins share a timestamp.

  Details: TC-2192

- Updated dependencies [9fb359a]
  - @tinycloud/sdk-core@3.8.0-beta.21

## 3.8.0-beta.20

### Minor Changes

- e424ba9: Include `siweConfig.resources` recipients-declaration URIs in ordinary, external/OpenKey and bootstrap SIWE preparation. This option accepts `urn:tinycloud:recipients:<base64url>` with an unpadded base64url payload. The original ReCap stays last and unchanged, and completion retains the exact signed message. An absent or empty resource list leaves preparation unchanged.

  Align shared ReCap extraction with complete resource values in the SIWE resources section.

  Details: TC-2230

### Patch Changes

- Updated dependencies [e424ba9]
  - @tinycloud/sdk-core@3.8.0-beta.20

## 3.8.0-beta.19

### Patch Changes

- Updated dependencies [19048ec]
  - @tinycloud/share-envelope@1.4.0-beta.2
  - @tinycloud/sdk-core@3.8.0-beta.19
  - @tinycloud/share-sdk@1.4.1-beta.3

## 3.8.0-beta.18

### Patch Changes

- Updated dependencies [3daddbb]
  - @tinycloud/sdk-services@3.8.0-beta.18
  - @tinycloud/replica@0.4.0-beta.5
  - @tinycloud/sdk-core@3.8.0-beta.18

## 3.8.0-beta.17

### Patch Changes

- Updated dependencies [0b024c2]
  - @tinycloud/share-sdk@1.4.1-beta.2
  - @tinycloud/sdk-core@3.8.0-beta.17

## 3.8.0-beta.16

### Minor Changes

- 812a818: Adds a Node SDK entry for receiving email-addressed shares with an agent session key and the existing OpenCredentials email proof flow.

  Details: TC-2202

### Patch Changes

- 812a818: Publish new CLI email shares as signed V3 Policy/v2 envelopes inside current v4 Share link records, with a unique exact `default/share/<shareId>` encryption key, a path-bound policy, and a committed email credential requirement. The `builtin:share-publishing` paste approval requests decrypt only for the owner's default-network `share/` prefix; device authorization and `enable share` omit decrypt. Existing V2 envelopes retain their read path.

  Details: TC-2177

- Updated dependencies [812a818]
  - @tinycloud/sdk-core@3.8.0-beta.16
  - @tinycloud/sdk-services@3.8.0-beta.16
  - @tinycloud/share-envelope@1.3.1-beta.1
  - @tinycloud/share-sdk@1.4.1-beta.1
  - @tinycloud/replica@0.4.0-beta.4

## 3.8.0-beta.15

### Patch Changes

- f167805: Allow `delegateTo` to issue an exact named-key decrypt resource when the signed session grants that key. The manifest permission rules remain the same.

  Details: TC-2140

- Updated dependencies [f167805]
  - @tinycloud/sdk-core@3.8.0-beta.15

## 3.8.0-beta.14

### Patch Changes

- e740a6d: A session key can list and revoke the delegations it issued. `DelegationManager.query({ direction: "issued" })` sends one invocation signed by the session's own did:key (capability `tinycloud.delegation/list` on `<did>/delegation`, no proof) and returns the schema-2 page; it needs `delegation-issued-query-v1` in the node's `/info` features and otherwise answers `UNSUPPORTED_OPERATION` ("This node doesn't support listing issued delegations yet"). `queryAllIssued()` follows `nextCursor` until it is absent (pages are ordered by delegation id and may be short). `revokeIssued(cid)` revokes a delegation the key issued with a revocation signed by that key and no proof; revoking an already revoked delegation succeeds, a plain-text 403 is `PERMISSION_DENIED` with the node's message, a 400 invalid cursor is `INVALID_CURSOR`, and a 503 is `CHAIN_TOO_DEEP` (retryable). `TinyCloudNode` wires the session-key signer (`DelegationManagerConfig.sessionInvocationSigner`).

  Details: TC-2132

- Updated dependencies [49f3665]
- Updated dependencies [e740a6d]
  - @tinycloud/sdk-core@3.8.0-beta.14

## 3.8.0-beta.13

### Patch Changes

- 32ed899: Export `isAppKeyHostBound(keysAppId, origin)`: the same host-binding check sign-in uses to decide whether a manifest's `keys` rows are granted for an origin.

  Details: TC-1977

## 3.8.0-beta.11

### Minor Changes

- 5d9d314: TinyCloudWeb supports OpenKey authorize-sign with popup approval and an optional prepared SIWE for click-triggered sign-in.

  Details: TC-1977

## 3.8.0-beta.10

### Patch Changes

- 20a872e: `@tinycloud/node-sdk/core` now exports `activateValidatedRuntimeDelegation`, `RuntimeDelegationRejectedError` and the `RuntimeDelegationRejection` type, which the root entry already exported. The web SDK uses them to verify and activate a stored panel grant after a reload.

  Details: TC-2113

## 3.8.0-beta.9

### Minor Changes

- 92e4bd0: Replication accepts contentFetch "lazy", which syncs entry names without downloading values; reads of values not held go to the network.

  Details: TC-2096

### Patch Changes

- Updated dependencies [92e4bd0]
  - @tinycloud/sdk-services@3.8.0-beta.9
  - @tinycloud/replica@0.4.0-beta.3
  - @tinycloud/sdk-core@3.8.0-beta.9

## 3.8.0-beta.7

### Patch Changes

- Updated dependencies [c6b4703]
  - @tinycloud/replica@0.4.0-beta.2

## 3.8.0-beta.6

### Patch Changes

- 479205d: Owner revocation signatures remain valid for 10 minutes from signing.

  Details: TC-2005

## 3.8.0-beta.5

### Patch Changes

- Updated dependencies [44c439a]
  - @tinycloud/sdk-core@3.8.0-beta.5

## 3.8.0-beta.4

### Minor Changes

- c541786: Manifests can declare named keys in the app's key namespace, with an optional `keys_app_id`. Sign-in includes the declared key permissions when the node supports named keys, prepares creatable key paths, and exposes the signed-in named-key client through `keys`.

  Details: TC-1977

### Patch Changes

- Updated dependencies [c541786]
  - @tinycloud/sdk-core@3.8.0-beta.4

## 3.8.0-beta.3

### Patch Changes

- @tinycloud/sdk-core@3.8.0-beta.3

## 3.8.0-beta.2

### Minor Changes

- 4a19c47: Signing out erases the local copy before `signOut()` resolves: the browser replica database is deleted under the origin gate lock after the deny commit, and the same erase runs when a different account signs in on a live session. The deny floor and logout marker in `localStorage` are kept.

  If the delete is blocked or the deny kept the keys (`marker`, `unguarded`), the erase is retried three times in total (150 ms, then 450 ms apart), the logout marker makes the next load finish it, and `signOut()` still resolves for `marker`. `unguarded` still rejects, now with `code: "REPLICA_PURGE_FAILED"` unless the erase completed. After the retries `replica.purge.failed` fires (`TinyCloudWeb.on` / `TinyCloudNode.on`) with `trigger`, a typed `reason` and `retryNow`.

  `tcw.replication.purgeLocalCopy()` runs the erase on demand and returns `{ ok: true }` or `{ ok: false, retryNow }`; it never touches a live session. New exported types: `ReplicaPurgeFailedEvent`, `ReplicaPurgeLocalCopyResult`, `ReplicaPurgeTrigger`, `ReplicaLocalEraseOutcome`, `ReplicaPurgeError`. `ReplicaLifecycleGate` gains the optional browser method `eraseLocalCopy`.

  A restore with replication configured and no wallet provider stays gated, now with the gate reason `wallet_provider_required` instead of `gate_unavailable`. A read-only provider (silent `eth_accounts`, signing methods that throw) still restores.

  Details: TC-1888

### Patch Changes

- Updated dependencies [4a19c47]
  - @tinycloud/sdk-services@3.8.0-beta.2
  - @tinycloud/sdk-core@3.8.0-beta.2
  - @tinycloud/replica@0.4.0-beta.1

## 3.8.0-beta.1

### Minor Changes

- 2789240: Replication accepts `syncScope: "prefixes"`, which keeps kv/sync on the declared prefixes at sign-in instead of widening to a root entry that covers them.

  Details: TC-2043

### Patch Changes

- Updated dependencies [2789240]
  - @tinycloud/sdk-services@3.8.0-beta.1
  - @tinycloud/sdk-core@3.8.0-beta.1
  - @tinycloud/replica@0.3.5-beta.0

## 3.8.0-beta.0

### Minor Changes

- 15080ed: `tc auth login --keys <folder>` (local-key or OpenKey sign-in) also grants named-key create and decrypt on keys below the folder, and `tc keys ensure|encrypt|decrypt` use them. Node SDK: `additionalRawAbilities` adds top-level resource abilities to the sign-in request.

  Details: TC-2034

## 3.7.0

### Minor Changes

- c142537: Add a named encryption key client: key create, block and unblock, key descriptor reads, `ensureKey`, and key-scoped encrypt and decrypt. It is exposed under the `@tinycloud/sdk-services/encryption/named-keys` and `@tinycloud/node-sdk/encryption-keys` subpaths and is only used with nodes that advertise support.

  Details: TC-1777

- 279c8e9: `storage.full` now fires once per episode of the signed-in account's own storage being full, instead of re-arming on every status read. The episode ends only when a committing write succeeds on that account's own space (kv `put` and `batchPut`, vault `put`, and SQL and DuckDB write actions). A successful `delete` or `get`, or a committed write to another owner's space, does not end it, and `storage.status()` reporting room no longer re-arms the event. `StorageFullMonitor.rejection` reports the own episode only, and `clear()` (sign-out, sign-in as another account) ends it. Breaking for code that relied on a status read to re-arm `storage.full`: call a committing write to see the next event. Delegated owners each emit once until a status read or a successful committing write clears them.

  web-sdk panel: adds a storage section showing the account's usage and state (ok, nearly full, full, unlimited). While the own-storage episode is active the panel shows "Storage is full" and hides the numbers, even if status still reports room. The needs-permission state offers "Allow" only when the client can ask for authority; otherwise it shows the permission note with no action. The manage link uses the status `manageUrl` only when it is https and otherwise falls back to the SDK's storage manage URL.

  web-sdk host: while the own-storage episode is on, the button and panel show "Storage is full", and one info toast with a manage link is shown per episode, even with the panel closed. A new toast appears only after the episode ends and a new one starts. Each full delegated owner gets one info toast with the same copy. The toast reads the manage link from status at toast time, so each toast adds one status request. A toast whose status read finishes after its episode has ended is not shown. With `ui.toasts` off, no toast is shown and no status request is made.

  Details: TC-848

- 71fa087: `authorizeShareDeliveryV3` sends the strict short-link body of `POST /policy/v3/deliveries/authorize` and checks the node's delivery admission v1.
  - The request body is exactly `{shareUrl, recipientEmail, documentName, jti, expiresAt, requestBodyDigest}`. `expiresAt` is `new Date(expiresAt).toISOString()` (`YYYY-MM-DDTHH:mm:ss.SSSZ`, UTC), whatever form the caller passes. `requestBodyDigest` is the base64url SHA-256 of the JCS of the body without it.
  - `shareUrl` must be a short share link (`/s/<id>#v=4&k=…&c=…`) on one of `trustedOrigins` (new optional input; default `https://share.tinycloud.xyz`, the `DEFAULT_SHARE_ORIGINS` of `@tinycloud/share-envelope/links`) with a lowercase id. Any other link throws `share delivery requires a short share link` before a request is made.
  - The `sealedEnvelope`, `envelopeKey` and `shareCid` inputs are removed. `envelope` stays an input: it checks the admission locally and is not sent.
  - The admission has the schema `xyz.tinycloud.policy/delivery-admission/v1` and the signing domain `xyz.tinycloud.policy/delivery-admission/v1\0`; `returnLink` is the submitted short link and `envelopeRef` is its `c`. A v0 admission is refused. `verifyShareDeliveryAuthorizationV3Bytes` (async) verifies a delivery admission with the strict Ed25519 rule of the links contract (`S < L`, canonical and prime-order `A` and `R`) and a canonical base64url signature, through `assertDidKeySignature` of `@tinycloud/share-envelope/links`.
  - HTTP 400 and HTTP 422 from the node are one refusal: a `ShareDeliveryRefusedError` (code `delivery-authorization-invalid`, status 400, message `share delivery authorization refused`) that carries nothing of the reply. Any other HTTP error carries the node's reply with the share link and its key replaced, so neither reaches a log or a thrown message.
  - HTTP 429 is not the refusal: it keeps its status and is retried by `notifyShare` like any other server answer.
  - `@tinycloud/sdk-core` exports `ShareDeliveryRefusedError`, `shortDeliveryLinkBodyCid`, `verifyShareDeliveryAuthorizationV3Bytes` and `withoutShareLink`, and loads `@tinycloud/share-envelope/links` with `import()` when it first needs it.
  - `@tinycloud/sdk-core` no longer exports `validateShareDeliveryAuthorizationV3Bytes`.

  Do not release before the node release that serves the new body.

  Details: TC-1737

### Patch Changes

- 147bb78: Encryption network invocations are re-signed with the key of the session that built them, so a sign-in with a manifest creates the account encryption network. Decrypting for an account with no default encryption network reports that the account needs to sign in again with a current SDK.

  Details: TC-1910

- Updated dependencies [c142537]
- Updated dependencies [4c3d073]
- Updated dependencies [279c8e9]
- Updated dependencies [71fa087]
- Updated dependencies [147bb78]
- Updated dependencies [14c685e]
  - @tinycloud/sdk-services@3.7.0
  - @tinycloud/sdk-core@3.7.0
  - @tinycloud/replica@0.3.4

## 3.7.0-beta.4

### Minor Changes

- c142537: Add a named encryption key client: key create, block and unblock, key descriptor reads, `ensureKey`, and key-scoped encrypt and decrypt. It is exposed under the `@tinycloud/sdk-services/encryption/named-keys` and `@tinycloud/node-sdk/encryption-keys` subpaths and is only used with nodes that advertise support.

  Details: TC-1777

### Patch Changes

- Updated dependencies [c142537]
- Updated dependencies [4c3d073]
  - @tinycloud/sdk-services@3.7.0-beta.4
  - @tinycloud/replica@0.3.4-beta.3
  - @tinycloud/sdk-core@3.7.0-beta.4

## 3.7.0-beta.3

### Minor Changes

- 279c8e9: `storage.full` now fires once per episode of the signed-in account's own storage being full, instead of re-arming on every status read. The episode ends only when a committing write succeeds on that account's own space (kv `put` and `batchPut`, vault `put`, and SQL and DuckDB write actions). A successful `delete` or `get`, or a committed write to another owner's space, does not end it, and `storage.status()` reporting room no longer re-arms the event. `StorageFullMonitor.rejection` reports the own episode only, and `clear()` (sign-out, sign-in as another account) ends it. Breaking for code that relied on a status read to re-arm `storage.full`: call a committing write to see the next event. Delegated owners each emit once until a status read or a successful committing write clears them.

  web-sdk panel: adds a storage section showing the account's usage and state (ok, nearly full, full, unlimited). While the own-storage episode is active the panel shows "Storage is full" and hides the numbers, even if status still reports room. The needs-permission state offers "Allow" only when the client can ask for authority; otherwise it shows the permission note with no action. The manage link uses the status `manageUrl` only when it is https and otherwise falls back to the SDK's storage manage URL.

  web-sdk host: while the own-storage episode is on, the button and panel show "Storage is full", and one info toast with a manage link is shown per episode, even with the panel closed. A new toast appears only after the episode ends and a new one starts. Each full delegated owner gets one info toast with the same copy. The toast reads the manage link from status at toast time, so each toast adds one status request. A toast whose status read finishes after its episode has ended is not shown. With `ui.toasts` off, no toast is shown and no status request is made.

  Details: TC-848

### Patch Changes

- Updated dependencies [279c8e9]
  - @tinycloud/sdk-services@3.7.0-beta.3
  - @tinycloud/replica@0.3.4-beta.2
  - @tinycloud/sdk-core@3.7.0-beta.3

## 3.7.0-beta.2

### Patch Changes

- 147bb78: Encryption network invocations are re-signed with the key of the session that built them, so a sign-in with a manifest creates the account encryption network. Decrypting for an account with no default encryption network reports that the account needs to sign in again with a current SDK.

  Details: TC-1910

- Updated dependencies [147bb78]
  - @tinycloud/sdk-services@3.7.0-beta.2
  - @tinycloud/replica@0.3.4-beta.1
  - @tinycloud/sdk-core@3.7.0-beta.2

## 3.7.0-beta.1

### Minor Changes

- 71fa087: `authorizeShareDeliveryV3` sends the strict short-link body of `POST /policy/v3/deliveries/authorize` and checks the node's delivery admission v1.
  - The request body is exactly `{shareUrl, recipientEmail, documentName, jti, expiresAt, requestBodyDigest}`. `expiresAt` is `new Date(expiresAt).toISOString()` (`YYYY-MM-DDTHH:mm:ss.SSSZ`, UTC), whatever form the caller passes. `requestBodyDigest` is the base64url SHA-256 of the JCS of the body without it.
  - `shareUrl` must be a short share link (`/s/<id>#v=4&k=…&c=…`) on one of `trustedOrigins` (new optional input; default `https://share.tinycloud.xyz`, the `DEFAULT_SHARE_ORIGINS` of `@tinycloud/share-envelope/links`) with a lowercase id. Any other link throws `share delivery requires a short share link` before a request is made.
  - The `sealedEnvelope`, `envelopeKey` and `shareCid` inputs are removed. `envelope` stays an input: it checks the admission locally and is not sent.
  - The admission has the schema `xyz.tinycloud.policy/delivery-admission/v1` and the signing domain `xyz.tinycloud.policy/delivery-admission/v1\0`; `returnLink` is the submitted short link and `envelopeRef` is its `c`. A v0 admission is refused. `verifyShareDeliveryAuthorizationV3Bytes` (async) verifies a delivery admission with the strict Ed25519 rule of the links contract (`S < L`, canonical and prime-order `A` and `R`) and a canonical base64url signature, through `assertDidKeySignature` of `@tinycloud/share-envelope/links`.
  - HTTP 400 and HTTP 422 from the node are one refusal: a `ShareDeliveryRefusedError` (code `delivery-authorization-invalid`, status 400, message `share delivery authorization refused`) that carries nothing of the reply. Any other HTTP error carries the node's reply with the share link and its key replaced, so neither reaches a log or a thrown message.
  - HTTP 429 is not the refusal: it keeps its status and is retried by `notifyShare` like any other server answer.
  - `@tinycloud/sdk-core` exports `ShareDeliveryRefusedError`, `shortDeliveryLinkBodyCid`, `verifyShareDeliveryAuthorizationV3Bytes` and `withoutShareLink`, and loads `@tinycloud/share-envelope/links` with `import()` when it first needs it.
  - `@tinycloud/sdk-core` no longer exports `validateShareDeliveryAuthorizationV3Bytes`.

  Do not release before the node release that serves the new body.

  Details: TC-1737

### Patch Changes

- Updated dependencies [71fa087]
  - @tinycloud/sdk-core@3.7.0-beta.1

## 3.6.2-beta.0

### Patch Changes

- Updated dependencies [14c685e]
  - @tinycloud/replica@0.3.4-beta.0

## 3.6.1

### Patch Changes

- 271155a: In the browser, the SIWE sign-in `domain` now uses `window.location.host` (it keeps the port) and, when the domain comes from the page, the SIWE `uri` defaults to `window.location.origin` (it keeps the scheme), so local http dev origins satisfy OpenKey's origin check (TC-1486). Production https origins on default ports are unchanged. `TinyCloudNodeConfig` gains an optional `uri`; a caller `siweConfig.uri` still takes precedence. (TC-1488)

  Details: TC-1488

- 09b7dc0: Document that `tinycloud.delegation/revoke` on a space is space-wide, and that the CLI's own fallback asks for 5 minutes and stores nothing. Added to the tc-cli skill docs and the node-sdk README.

  Details: TC-1923
  - @tinycloud/sdk-core@3.6.1
  - @tinycloud/sdk-services@3.6.1

## 3.6.1-beta.1

### Patch Changes

- 09b7dc0: Document that `tinycloud.delegation/revoke` on a space is space-wide, and that the CLI's own fallback asks for 5 minutes and stores nothing. Added to the tc-cli skill docs and the node-sdk README.

  Details: TC-1923

## 3.6.1-beta.0

### Patch Changes

- 271155a: In the browser, the SIWE sign-in `domain` now uses `window.location.host` (it keeps the port) and, when the domain comes from the page, the SIWE `uri` defaults to `window.location.origin` (it keeps the scheme), so local http dev origins satisfy OpenKey's origin check (TC-1486). Production https origins on default ports are unchanged. `TinyCloudNodeConfig` gains an optional `uri`; a caller `siweConfig.uri` still takes precedence. (TC-1488)

  Details: TC-1488

## 3.6.0

### Minor Changes

- 7bd4ae6: `@tinycloud/node-sdk/credentials` adds `verifyStoredEmailProof`, which re-verifies a stored email-proof credential offline: descriptor digest pin, envelope rebuild, pinned issuer keys, status check, and holder match. `@tinycloud/node-sdk/credential-pending-store` exports `ensureSecureDir` and `checkSecureDir`. The credentials directory must be a real directory with owner-only mode; a symlink or a file is refused, and a pre-existing directory with loose permissions is refused rather than chmodded. A pending request expires at the earlier of the witness expiry and 15 minutes after creation.

  `courier credential acquire` writes one JSON document to stdout per call (pretty printed, nothing else on stdout; hints go to stderr): `status: "code-sent"` with `codeExpiresAt` on the first call, then `status: "acquired"` with `issuedAt` and `expiresAt` on the second. The verification code must be entered within 5 minutes. `courier credential show` writes one JSON document with `address`, `credentialId`, `issuedAt`, `expiresAt`, and `status`, never the credential. Stored credentials are re-verified offline on every read before any other rule applies; a record that fails is refused with `credential-record-invalid` and kept, and nothing is deleted on the strength of unverified stored fields. A credential that passed verification is dropped when less than 60 seconds of its own expiry remain or once older than the 3600-second maximum age. Courier refuses to run when both `HOME` and `COURIER_HOME` are unset. `courier --version` prints the package version.

  Details: TC-1757

- e32bc41: feat(credentials): add email-proof credential acquisition
  - `@tinycloud/node-sdk/credentials` exports `requestEmailProofCode`, `completeEmailProof`, and `acquireEmailProof` for a two-step flow: request a one-time code for an address, then exchange it for a verifiable credential.
  - Errors are `EmailProofError` with a `step`, a stable `code`, `retryAfterMs`, and `recoverable`.
  - `@tinycloud/node-sdk/credential-pending-store` provides a file-backed pending store: owner-only files, 15-minute maximum lifetime, deleted after success or any unrecoverable failure.
  - `@tinycloud/web-sdk` re-exports the same types. Existing root behaviour is unchanged; the root bundle contains no email-proof code.
  - `@tinycloud/sdk-core`: `CredentialError` accepts an explicit `recoverable` flag that overrides the per-code default. `@tinycloud/node-sdk` needs this to keep the witness's recoverable flag on server errors.

  Release order: `@tinycloud/sdk-core`, then `@tinycloud/node-sdk`, then `@tinycloud/web-sdk`. Node-sdk pins sdk-core exactly, so sdk-core must publish first for that pin to carry the recoverable override.

  Details: TC-712

- c0acb86: Adds email-proof credential acquisition as `@tinycloud/node-sdk/credentials-core` (narrow entry, no web-sdk dependency) and `@tinycloud/node-sdk/credential-pending-store` (owner-only, one file per pending request). The `@tinycloud/node-sdk/credentials` entry adds `requestEmailProofCode`, `completeEmailProof`, `acquireEmailProof`, `createEd25519HolderSigner`, `emailProofRequirement`, and `EmailProofError`. The root entry gains no email-proof exports.

  Details: TC-712

### Patch Changes

- e600a1a: Runtime permission grants that include decrypt follow the same expiry handling as other grants. `secrets.get` still asks only for the permission entries that are not already covered.

  Details: TC-1781

- 0c09d7b: Add `allowSubDelegation` to share generation. It defaults to `true`, which keeps today's behavior. Passing `false` issues a terminal delegation: the node refuses onward delegation of the share. A non-transferable share must be covered by an existing session-key delegation; it is refused when none covers it, and the wallet root path is not used for it.

  A non-transferable share is received with `receive(link, { autoSubdelegate: false })`; the default auto-subdelegation is refused for it.

  Details: TC-1801

- 1f831e3: Manifest sign-in and session preparation refuse a permission that carries caveats by throwing the existing `CaveatedDelegationUnsupportedError` (`CAVEATED_DELEGATION_UNSUPPORTED`) before any request or signature. Absent, `[]` and `[{}]` caveats are accepted; any other set, including `[{}, {}]`, is refused, the same rule the delegation paths apply through `recapCaveatsEqual`.

  Refusing call sites: `TinyCloudNode.signIn`, `signInWithOpenKey`, `createOwnerDelegation` and `createSubDelegation` permissions; `NodeUserAuthorization.signIn`, `prepareSessionForSigning`, `signInWithOpenKey` and `createBootstrapSession`; `TinyCloudWeb.signIn` (before any persisted session is restored).

  Details: TC-1855

- 7bd4ae6: `courier credential show` no longer deletes a stored credential that fails offline re-verification. The record is refused with `credential-record-invalid` and kept under `COURIER_HOME/credentials/` for inspection. Lifecycle drops are unchanged: a credential within 60 seconds of its own expiry, or older than the 3600-second maximum age, is still deleted.

  `@tinycloud/node-sdk/credentials` also exports the `StoredEmailProofInput` type.

  `@tinycloud/web-sdk/credentials` adds `verifyStoredEmailProof` and the `StoredEmailProofInput` and `StoredEmailProofRecord` types, so headless clients can re-verify a stored email-proof credential offline without importing `@tinycloud/node-sdk` directly.

  Details: TC-712

- Updated dependencies [0c09d7b]
- Updated dependencies [82cbd43]
- Updated dependencies [dc61583]
- Updated dependencies [1f831e3]
- Updated dependencies [e32bc41]
  - @tinycloud/sdk-core@3.6.0
  - @tinycloud/sdk-services@3.6.0
  - @tinycloud/replica@0.3.3

## 3.6.0-beta.8

### Patch Changes

- 1f831e3: Manifest sign-in and session preparation refuse a permission that carries caveats by throwing the existing `CaveatedDelegationUnsupportedError` (`CAVEATED_DELEGATION_UNSUPPORTED`) before any request or signature. Absent, `[]` and `[{}]` caveats are accepted; any other set, including `[{}, {}]`, is refused, the same rule the delegation paths apply through `recapCaveatsEqual`.

  Refusing call sites: `TinyCloudNode.signIn`, `signInWithOpenKey`, `createOwnerDelegation` and `createSubDelegation` permissions; `NodeUserAuthorization.signIn`, `prepareSessionForSigning`, `signInWithOpenKey` and `createBootstrapSession`; `TinyCloudWeb.signIn` (before any persisted session is restored).

  Details: TC-1855

- Updated dependencies [1f831e3]
  - @tinycloud/sdk-core@3.6.0-beta.8

## 3.6.0-beta.7

### Minor Changes

- 7bd4ae6: `@tinycloud/node-sdk/credentials` adds `verifyStoredEmailProof`, which re-verifies a stored email-proof credential offline: descriptor digest pin, envelope rebuild, pinned issuer keys, status check, and holder match. `@tinycloud/node-sdk/credential-pending-store` exports `ensureSecureDir` and `checkSecureDir`. The credentials directory must be a real directory with owner-only mode; a symlink or a file is refused, and a pre-existing directory with loose permissions is refused rather than chmodded. A pending request expires at the earlier of the witness expiry and 15 minutes after creation.

  `courier credential acquire` writes one JSON document to stdout per call (pretty printed, nothing else on stdout; hints go to stderr): `status: "code-sent"` with `codeExpiresAt` on the first call, then `status: "acquired"` with `issuedAt` and `expiresAt` on the second. The verification code must be entered within 5 minutes. `courier credential show` writes one JSON document with `address`, `credentialId`, `issuedAt`, `expiresAt`, and `status`, never the credential. Stored credentials are re-verified offline on every read before any other rule applies; a record that fails is refused with `credential-record-invalid` and kept, and nothing is deleted on the strength of unverified stored fields. A credential that passed verification is dropped when less than 60 seconds of its own expiry remain or once older than the 3600-second maximum age. Courier refuses to run when both `HOME` and `COURIER_HOME` are unset. `courier --version` prints the package version.

  Details: TC-1757

### Patch Changes

- 7bd4ae6: `courier credential show` no longer deletes a stored credential that fails offline re-verification. The record is refused with `credential-record-invalid` and kept under `COURIER_HOME/credentials/` for inspection. Lifecycle drops are unchanged: a credential within 60 seconds of its own expiry, or older than the 3600-second maximum age, is still deleted.

  `@tinycloud/node-sdk/credentials` also exports the `StoredEmailProofInput` type.

  `@tinycloud/web-sdk/credentials` adds `verifyStoredEmailProof` and the `StoredEmailProofInput` and `StoredEmailProofRecord` types, so headless clients can re-verify a stored email-proof credential offline without importing `@tinycloud/node-sdk` directly.

  Details: TC-712

## 3.6.0-beta.6

### Patch Changes

- e600a1a: Runtime permission grants that include decrypt follow the same expiry handling as other grants. `secrets.get` still asks only for the permission entries that are not already covered.

  Details: TC-1781

## 3.6.0-beta.5

### Minor Changes

- c0acb86: Adds email-proof credential acquisition as `@tinycloud/node-sdk/credentials-core` (narrow entry, no web-sdk dependency) and `@tinycloud/node-sdk/credential-pending-store` (owner-only, one file per pending request). The `@tinycloud/node-sdk/credentials` entry adds `requestEmailProofCode`, `completeEmailProof`, `acquireEmailProof`, `createEd25519HolderSigner`, `emailProofRequirement`, and `EmailProofError`. The root entry gains no email-proof exports.

  Details: TC-712

## 3.6.0-beta.4

### Minor Changes

- e32bc41: feat(credentials): add email-proof credential acquisition
  - `@tinycloud/node-sdk/credentials` exports `requestEmailProofCode`, `completeEmailProof`, and `acquireEmailProof` for a two-step flow: request a one-time code for an address, then exchange it for a verifiable credential.
  - Errors are `EmailProofError` with a `step`, a stable `code`, `retryAfterMs`, and `recoverable`.
  - `@tinycloud/node-sdk/credential-pending-store` provides a file-backed pending store: owner-only files, 15-minute maximum lifetime, deleted after success or any unrecoverable failure.
  - `@tinycloud/web-sdk` re-exports the same types. Existing root behaviour is unchanged; the root bundle contains no email-proof code.
  - `@tinycloud/sdk-core`: `CredentialError` accepts an explicit `recoverable` flag that overrides the per-code default. `@tinycloud/node-sdk` needs this to keep the witness's recoverable flag on server errors.

  Release order: `@tinycloud/sdk-core`, then `@tinycloud/node-sdk`, then `@tinycloud/web-sdk`. Node-sdk pins sdk-core exactly, so sdk-core must publish first for that pin to carry the recoverable override.

  Details: TC-712

### Patch Changes

- Updated dependencies [e32bc41]
  - @tinycloud/sdk-core@3.6.0-beta.4

## 3.6.0-beta.3

### Patch Changes

- Updated dependencies [82cbd43]
  - @tinycloud/sdk-services@3.6.0-beta.3
  - @tinycloud/replica@0.3.3-beta.1
  - @tinycloud/sdk-core@3.6.0-beta.3

## 3.6.0-beta.2

### Patch Changes

- Updated dependencies [dc61583]
  - @tinycloud/sdk-services@3.6.0-beta.2
  - @tinycloud/replica@0.3.3-beta.0
  - @tinycloud/sdk-core@3.6.0-beta.2

## 3.6.0-beta.0

### Patch Changes

- 0c09d7b: Add `allowSubDelegation` to share generation. It defaults to `true`, which keeps today's behavior. Passing `false` issues a terminal delegation: the node refuses onward delegation of the share. A non-transferable share must be covered by an existing session-key delegation; it is refused when none covers it, and the wallet root path is not used for it.

  A non-transferable share is received with `receive(link, { autoSubdelegate: false })`; the default auto-subdelegation is refused for it.

  Details: TC-1801

- Updated dependencies [0c09d7b]
  - @tinycloud/sdk-core@3.6.0-beta.0

## 3.5.0

### Minor Changes

- d60f81d: Add an opt-in, in-memory developer request log. With `requestLog: true` in `TinyCloudNode` config, the log records requests the SDK makes on your behalf: operation, path (first segment only), space (the name after the last colon), host, size, duration, attempts, result and source. Read them from `node.requests`, a read-only view with `snapshot()`, `subscribe()` and `onClear()`. The log keeps the most recent 500 entries and is cleared on sign-out, on sign-in as another account, and when a session is restored for a different owner. Entries carry sizes only; body and header content is absent from them. When the option is omitted, no log is created and no events are built.

  Details: TC-848

- 7b92156: `grantRuntimePermissions` applies a one-hour decrypt limit to decrypt grants on the account's own networks: the default network and any non-share network. Decrypt grants are those with `tinycloud.encryption/decrypt`, or an action covering it such as `tinycloud.encryption/*`. Without an `expiry`, such grants default to one hour instead of 30 days. An explicit `expiry` over one hour is refused with an error whose `code` is `DECRYPT_EXPIRY_TOO_LONG`. Decrypt grants on per-share networks keep their own lifetime. Grants without decrypt are unchanged.

  Details: TC-1781

### Patch Changes

- 7b92156: `secrets.get` now escalates only the permission entries that are not already covered. A read whose entries are all covered completes without a signer or a new grant. Escalations made by `secrets.get` expire after 59 minutes. Details: TC-1781
- Updated dependencies [d60f81d]
  - @tinycloud/sdk-services@3.5.0
  - @tinycloud/replica@0.3.2
  - @tinycloud/sdk-core@3.5.0

## 3.5.0-beta.1

### Minor Changes

- 7b92156: `grantRuntimePermissions` applies a one-hour decrypt limit to decrypt grants on the account's own networks: the default network and any non-share network. Decrypt grants are those with `tinycloud.encryption/decrypt`, or an action covering it such as `tinycloud.encryption/*`. Without an `expiry`, such grants default to one hour instead of 30 days. An explicit `expiry` over one hour is refused with an error whose `code` is `DECRYPT_EXPIRY_TOO_LONG`. Decrypt grants on per-share networks keep their own lifetime. Grants without decrypt are unchanged.

  Details: TC-1781

### Patch Changes

- 7b92156: `secrets.get` now escalates only the permission entries that are not already covered. A read whose entries are all covered completes without a signer or a new grant. Escalations made by `secrets.get` expire after 59 minutes. Details: TC-1781

## 3.5.0-beta.0

### Minor Changes

- d60f81d: Add an opt-in, in-memory developer request log. With `requestLog: true` in `TinyCloudNode` config, the log records requests the SDK makes on your behalf: operation, path (first segment only), space (the name after the last colon), host, size, duration, attempts, result and source. Read them from `node.requests`, a read-only view with `snapshot()`, `subscribe()` and `onClear()`. The log keeps the most recent 500 entries and is cleared on sign-out, on sign-in as another account, and when a session is restored for a different owner. Entries carry sizes only; body and header content is absent from them. When the option is omitted, no log is created and no events are built.

  Details: TC-848

### Patch Changes

- Updated dependencies [d60f81d]
  - @tinycloud/sdk-services@3.5.0-beta.0
  - @tinycloud/replica@0.3.2-beta.0
  - @tinycloud/sdk-core@3.5.0-beta.0

## 3.4.0

### Patch Changes

- Updated dependencies [6139879]
  - @tinycloud/replica@0.3.1
  - @tinycloud/sdk-core@3.4.0
  - @tinycloud/sdk-services@3.3.2

## 3.3.2-beta.1

### Patch Changes

- @tinycloud/sdk-core@3.3.2-beta.1

## 3.3.2-beta.0

### Patch Changes

- Updated dependencies [6139879]
  - @tinycloud/replica@0.3.1-beta.0

## 3.3.1

### Patch Changes

- @tinycloud/sdk-core@3.3.1
- @tinycloud/sdk-services@3.3.1

## 3.3.1-beta.0

### Patch Changes

- @tinycloud/sdk-core@3.3.1-beta.0

## 3.3.0

### Minor Changes

- d2ad845: `tc delegation create` now signs and activates the delegation through `delegateTo`, reads it back through the node's account delegation query, and prints its CID only once the node lists it as active (`DELEGATION_NOT_CONFIRMED` otherwise). `tc delegation list` and `tc delegation info` use that query (`POST /delegation/query`) via `account.delegations.query()`, which includes delegations signed by the session key; `list` gains `--space`, and `--to` accepts a `did:key` with a `#fragment`. Previously `create` and `list` sent `tinycloud.delegation/create` and `tinycloud.delegation/list` invocations that the node does not handle (it answered an empty 200, surfaced as a JSON parse error), and `info` called a method that did not exist.

  A plain `tc auth login` now also requests `tinycloud.delegation/list` on the default space (OpenKey's default grant omits it). A session that lacks it, on the account space and its own space, gets a `PERMISSION_DENIED` error saying to run `tc auth login` again. `DelegationManager.query()` signs for the account space and falls back to the session's own space when the node refuses (403).

  Breaking: removed `DelegationManager.create()` (use `TinyCloudNode.delegateTo()`), `DelegationManager.list()` (use `account.delegations.query()`), `TinyCloudNode.delegate()` (use `delegateTo()`), `TinyCloudNode.listDelegations()` (use `account.delegations.query()`), and the web-sdk `TinyCloudWeb.delegate()` (use `delegateTo()`) and `TinyCloudWeb.listDelegations()` (use `account.delegations.query()`). They sent invocations the node never handled, so they never worked. `account.delegations.list()` is not a replacement: it reads the SQL index and omits session-signed delegations. Also removed the `delegationManager` option from `SharingService` config; sharing uses `createDelegation` or `createDelegationWasm`.

  `TinyCloudNode.delegateTo()` takes a new `requireActivation` option: when set, it throws when the node answers 200 but lists a target space under `skipped` (a space it does not host), naming that space; this used to look like success. It is off by default, since grants to a not-yet-hosted space (e.g. secrets) are valid. `tc delegation create` sets it. `DelegationManager.getChain()` and `checkPermission()` now return an `UNSUPPORTED_OPERATION` error when the node answers with an empty body.

- 38980b0: Stamp replica sessions only from a fully verified owner SIWE with finite signed expiry and exact-space KV get+sync authority; missing proof refuses only the replica, not network sign-in. Restore validates the persisted stamp without repairing it. Browser IndexedDB sign-in, restore, and sign-out use its lifecycle without a Node profile directory; sign-out denies the gate and shreds replica keys. Replication-disabled sign-in does not inspect replica SIWE metadata.

  Node exports `createProfileReplicaPurge({ profileDir, guard })` for profile-locked CLI cleanup. A failed online revoke can durably deny local reads with `deny({ reason: "sign_out", principal }, { deferErase: true })` while retaining the network session, key, and replica files. The returned epoch/principal token resumes erasure after remote success; recovery leaves deferred files untouched and retries ordinary erasure after resume. `TinyCloudNode.signOut()` awaits durable denial before registry cleanup.
  `logoutPrincipalDigest(principal)` exposes the owner binding stored as a logout marker's `principalDigest` (advisory; not authority), so callers can check a marker against the current session before recovery.
  Node denial reads the gate snapshot and hashes the principal under the same profile lock as `denyGate`; partition and pending intents use that snapshot's salt. A gate established while denial waits for the lock is included rather than producing an empty-salt intent inventory.
  `ProfileReplica*` facade types now come from `@tinycloud/sdk-services/kv/replication`; Node SDK retains the runtime factory and marker exports without duplicate type declarations or aliases.
  Node direct sign-out and account-switch denial emits one `replication.lifecycle` event after a committed `denied`, `database_deleted`, or `marker_set` outcome to both `replication.onEvent` and the leaving service context. Stale and unguarded outcomes cannot claim a committed denial; the event carries no raw principal or space.

  CLI logout uses a profile-locked, fsynced opaque `replica-logout-pending.json` marker before deleting either `session.json` or `key.json`. CLI-bound replica reads, pending writes, restores, and already-open handles refuse while it exists. Startup recovery verifies the marker's gate incarnation/epoch/principal hash, commits full purge intents or resumes a deferred denial, removes and fsyncs both credentials, then removes the marker before retrying erase. Generic SQLite storage does not infer CLI session files; CLI callers opt in with `logoutPendingFile`. A successful remote revoke follows this same credential-shredding path; failed revoke keeps its deferred gate and credentials for retry. `recoverLogoutPending().remaining` counts durable intents only; `failed` or the marker indicates incomplete logout even when that count is zero. If writing the marker fails, an ordinary gate denial can still fence replica reads but cannot by itself recover a crash before credential unlink.
  For an active v1 plain logout, recovery commits the full generation-fenced denial and opaque intent inventory under the profile lock before calling `clearCredentials`. A denied gate write leaves the marker, both credentials, and replica files intact for retry. After a BUSY plain cleanup, reapproval recognizes that marker's same incarnation and next denied epoch with a null `deferredPrincipalHash`; the existing deferred-owner path remains intact. Remote-pending, successor, and stale markers remain fenced.

  `recoverLogoutPending` requires an idempotent `eraseLegacyReplicas` callback for the CLI's separate `<profile>/replicas` root. It runs only after the gate's full intent/generation commit, while the marker still blocks reads; the facade verifies the legacy root is gone and fsyncs the profile before clearing the marker. Failure or interruption retains the marker for retry. The callback must never delete S3's `<profile>/replication` root.
  On retry after a busy legacy SQLite lease, only source-created `replica.db-wal`, `replica.db-shm`, and `replica.db-journal` sidecars may be regenerated. Recovery still requires the originally approved database and replica directory identities; a path approved as unknown never acquires the known-sidecar exception.

  An inactive gate also gets an epoch-bound logout marker while opaque intents or legacy replicas remain. Recovery retains it until legacy-only cleanup completes; a successor gate cannot replay the old marker.

  An already-deferred v1 gate cannot mint a missing pre-denial logout marker or authorize remote revoke from its later denied epoch. Explicitly approved corrupt gates use a v2 orphan marker: after that marker is durable, the still-corrupt gate file is removed and fsynced before remote work; remote completion still requires the gate to be absent. Because that marker has no original gate-file identity, a later retry or reapproval never unlinks an unreadable gate; it fails closed with the marker and any not-yet-erased credentials or replica files intact until the gate is absent. Orphan recovery also refuses a newly corrupt or valid replacement gate before credential cleanup and again before marker removal; failures retain the marker for retry. Failed initial removal retains the marker and credentials.

  When the CLI profile's gate is missing or corrupt, scoped intents cannot be reconstructed. `prepareLogoutPending({ principal, discardLocalChanges? })` instead writes a distinct opaque orphan-profile marker before credential unlink. Without explicit `discardLocalChanges`, unsynced `pending.json` records, an unrecognized flag-owned layout, an unknown legacy child or SQLite schema, or a corrupt/unreadable gate refuse with sync-first/`--discard-local-changes` guidance. Recovery under the profile lock shreds and fsyncs both credentials, wipes only validated real `<profile>/replication` and `<profile>/replicas` roots, confirms absence and fsyncs the profile, then removes the marker. Root deletion failure leaves the marker; neither scoped intents nor a replacement gate are fabricated. CLI sign-in must check the marker before persisting a new session.

  The orphan wipe accepts the CLI lock's exact Linux `/proc/self/fd/<n>` directory pin as well as a real profile directory. It validates each replica root against that pinned directory, refuses arbitrary profile symlinks and closed pins even when roots are absent, and never redirects a wipe to a replacement profile-name symlink. With a missing gate, only a validated identity record plus an inspected empty `pending.json` and no other identity children prove a flag-owned partition has no unsynced writes; a missing index, replica files, device key, or unknown child format requires explicit discard.

  `TinyCloudNode.replicaStamp` exposes a defensive copy of the active verified stamp after sign-in or validated restore; sign-out clears it. `TinyCloudNode.signInWithOpenKey(authorizeFn, options?)` prepares the original SIWE before OpenKey approval and verifies the signed result through the existing authorization flow before committing the network session and replica stamp. The callback receives the SDK-prepared `verificationMethod` for local session-DID handoff, not as an OpenKey wire field. Optional `retryResult(error, originalRequest, attempt)` retries rejected callback transport or signed results against that same SIWE and key without retrying network activation.

  Prefix-scoped, uncaveated signed KV get+sync authority now anchors replica consent as well as root authority. Node SQLite reads pair rows with a fence captured before their SQLite snapshot. A CID's original grant installation time survives targeted partition purge; an expired effective grant refuses synchronization before transport and refuses a page that expires before commit.

- 87a137e: Retry node `NODE_BUSY` and `REQUEST_TIMEOUT` answers automatically. Both mean nothing was applied, so the services now retry them under the existing `retryPolicy` through the new `ServiceContext.invokeWithRetry(url, build)`, which calls `build` once per attempt so every attempt carries a freshly signed invocation (the node answers a repeated invocation with 409, so re-sending one could never succeed). `ServiceContext.fetch` itself no longer retries. A context without `invokeWithRetry` sends once. The policy: at most 4 attempts in about 12 s, honouring the node's `Retry-After` (capped at the remaining budget) and otherwise backing off exponentially with full jitter (250 ms base, 4 s cap). Aborts and per-request timeouts end the wait at once, and `OUTCOME_UNKNOWN` is never retried. `defaultRetryPolicy` changes accordingly (its retryable codes are now `NODE_BUSY` and `REQUEST_TIMEOUT`; `NETWORK_ERROR` and `TIMEOUT` are no longer listed because no service read them), and `RetryPolicy` gains an optional `maxTotalMs`. Opt out with `retryPolicy: { maxAttempts: 1 }`.

  The CLI gains `--no-retry` and `TINYCLOUD_RETRY=0` for monitors and probes that must see the node's honest `NODE_BUSY`. KV responses (and `tc kv get|put|delete --json`) report `attempts` and `backoffMs`.

- cce8b26: Add an opt-in `registryPolicy: "fail-closed"` for host resolution and automatic space creation (TC-1443). The default does not change.

  **Default (`"legacy-fallback"`, deprecated).** Sign-in resolves hosts exactly as before: when the location registry has no record or cannot be reached, the session silently uses the fallback host (`https://node.tinycloud.xyz` unless `tinycloudFallbackHosts` says otherwise). The first time a process takes that fallback it logs one `console.warn`; the fallback will be removed in a future major release. The default policy adds no registry request anywhere and no space-creation check.

  **`registryPolicy: "fail-closed"`** (`TinyCloudNodeConfig`, `NodeUserAuthorizationConfig`, web `Config`):
  - Sign-in without a configured host looks up the signer address in the registry first and acts on the three-state verdict. `registered`: the record's hosts, in record order. `unregistered`: `newUserHost` (default `https://node.tinycloud.xyz`; `null` refuses unregistered owners with `NodeNotFoundError`). `unavailable` (unreachable, timeout, bad status, oversize or malformed body, bad signature, a sequence below the remembered one, a not-found after a registration was seen, a failed read of the remembered sequence, or no registry configured): `RegistryUnavailableError`, never the new-user host. A record with no usable host is `NodeNotFoundError`. `newUserHost` governs routing only; a pinned host may still create spaces for an unregistered owner.
  - One host-scheme rule: hosts from a signed record are used for routing and for space creation only if they are HTTPS or HTTP on loopback, the same rule as `newUserHost` and `use-host`. The default policy is unchanged.
  - Local discovery probes the configured `localNodeUrl` / `localLinkName` and `*.local.tinycloud.link` hosts from a `registered` verdict; it no longer reads the registry itself, so an older or invalid record cannot route a session.
  - The lookup key is the signer address, never the session chain. The v1 registry keys records on an exact `did:pkh:eip155:<chain>:<EIP-55 address>`, so v1 lookups use `registryOwnerSubjectV1(address, registryChainId)` (`registryChainId` default 1). Registry v2 will key on the address alone.
  - `onNodeNotFound({ error, attempt })` decides what sign-in does instead of throwing: `{ action: "retry" }`, `{ action: "use-host", host }` (an HTTPS or loopback HTTP origin) or `{ action: "abort" }`. The SDK does not verify a `use-host` host's identity, and the choice persists with the session like any resolved host.
  - Automatic space creation is guarded: `ensureSpaceExists` (before asking the creation handler), account bootstrap host steps, sign-in's owned-space hosting, `ensureOwnedSpaceHosted`, and `ensurePublicSpace` (which the vault calls on unlock). Creating a space is refused with `NodeRegistryEntryExistsError` when the owner's registry record does not list the host (including a record with no hosts), and with `RegistryUnavailableError` when the registry gives no verdict. The space-creation handler's `onSpaceCreationFailed` receives the error. Pinned-host apps look the verdict up once, at creation. An explicit `hostOwnedSpace()` call is not guarded.
  - The highest record sequence seen per owner is remembered in `registrySequenceStore` (default in memory; web-sdk defaults to `localStorage` under `tinycloud.registrySequences.v1`). A failed write (full or read-only storage) logs one warning and keeps the verdict in hand, and the `localStorage` store still remembers the sequence for the page. A failed read or a corrupt stored value fails that lookup closed; remove the key to reset.

  New sdk-core exports: `resolveOwnerHosts`, `lookupOwnerRegistryVerdict`, `resolveFailClosedTinyCloudHosts`, `assertSpaceCreationAllowed`, `registryOwnerSubjectV1`, `createInMemoryRegistrySequenceStore`, `createLocalStorageRegistrySequenceStore`, the errors `NodeNotFoundError` (`code: "node_not_found"`), `RegistryUnavailableError` (`"registry_unavailable"`) and `NodeRegistryEntryExistsError` (`"node_registry_entry_exists"`), their option and callback types, and `DEFAULT_NEW_USER_HOST`, `DEFAULT_REGISTRY_OWNER_CHAIN_ID`, `DEFAULT_REGISTRY_LOOKUP_TIMEOUT_MS` (3 s) and `DEFAULT_REGISTRY_SEQUENCE_STORAGE_KEY`. Match errors on `error.code`: web-sdk bundles its own sdk-core, so `instanceof` against an app's separate sdk-core copy does not hold.

- 0c4c6b2: `ProfileReplicaPurge.deny` with `{ deferErase: true }` now accepts only `reason: "sign_out"` and returns `ProfileReplicaDeferredDenyOutcome`, whose committed `denied` always carries `resumeToken`. `ReplicaEraseReport.deferred: true` marks a pass held by a deferred denial, so `remaining: 0` there is not completion. node-sdk exports the full contract `ProfileReplicaPurge`, requires the displayed `approval` in `prepareLogoutPending`, and reports `purgePending` from inspected status while a deferred denial or any intent remains.

  A v1 logout marker records the epoch its denial actually committed (`deniedEpoch`) in the same locked section as the deny, and every later check compares with it. A sign-out interrupted between its deny floor and gate writes is completed by the next `auth logout` (`@tinycloud/replica/profile-gate` adds `readLogoutGate`, `advanceInactiveGate` and `REPLICA_DENY_FLOOR_FILE`); reads report "a previous sign-out was interrupted; re-running `tc auth logout` completes it". A restored older gate under a recorded denial refuses with the `tc profile delete` route.

  `auth logout` by an account other than the one whose replicas the profile holds writes no marker and leaves that account's gate, floor and replicas untouched: it signs out, removes its own session and key, and erases the profile's legacy `replicas/` mirror (replayed at startup after a crash). `--revoke` there revokes only grants on the signed-in account's spaces.

  When startup recovery refuses a pending logout because a credential file is unreadable, the message now names that file (`session.json` or `profile.json`).

  CLI-bound storage and purge name the CLI's `replication/events.jsonl` and `events.jsonl.1` diagnostics logs (`diagnosticFiles`). With a readable gate, those exact names count as known only while they are regular files, so a fully synced profile signs out without `--discard-local-changes`; a symlink there stays unknown.

- f97d73d: `disableSubDelegation: true` now sets the node's terminal marker (the UCAN fact `xyz.tinycloud.policy/delegationMode: "terminal"`), so the node refuses any delegation that cites the result as a parent. It applies to `createDelegation`, the `space.delegations.create` wiring, and the new `delegateTo` option of the same name; the returned delegation reports `disableSubDelegation: true`. sdk-core exports `TERMINAL_DELEGATION_FACT` and `markDelegationTerminal` (TC-1436).

  Behaviour change, released as `minor` because the repository's versioning rule allows agents only `minor` or `patch` (a major needs a maintainer's sign-off). What breaks:
  - `disableSubDelegation: true` now throws instead of issuing a wallet-signed delegation that can still be re-delegated: in `createSubDelegation`, in `delegateTo` with `forceWalletSign`, and in `createDelegation` when the requested capabilities are outside the current session.
  - A terminal delegation still works for a delegate that uses it directly, but a wallet-mode `useDelegation`, which chains a new session from it, is refused by the node.

### Patch Changes

- 2aa917e: Sign account-only manifests into the account space they authorize, and expose the active authorization CID after restoring a persisted browser session.
- b6d0b9f: `tc account` commands now exit with `ACCOUNT_ACCESS_REQUIRED` (exit 5) before calling the node when the session lacks the account-space abilities that command invokes, as with a plain OpenKey login. Each command checks its own set (registry reads and writes, `kv/del` for removals, `space/list` and `capabilities/read` on the primary space for the commands that list spaces or delegations). `account delegations revoke` needs no session ability on a local-key profile (it signs with the owner wallet) and is refused with the `tc delegation revoke` command on an OpenKey profile, which cannot carry the raw-CID revoke ability, and the error prints the `tc auth request --grant --cap ...` command that grants exactly those, with a `--paste` variant. `tc auth request --grant` gains `--paste` (OpenKey owner profiles) for browsers that cannot reach the CLI's loopback callback, and a grant that spans several spaces now says up front how many OpenKey approvals it takes (one per space) and numbers each prompt. The account registry sync skip is recorded once per process as a debug event only (`TinyCloud_debug=true`).
- 29440be: Wallet-backed `TinyCloudNode.revokeDelegation(cid)` now signs a direct owner revocation for the target CID. Session-only clients continue to use their delegated revocation authority; the node receipt must confirm the requested CID (TC-721, TC-821).
- a553392: Agents can pick up the apps a user installed, from their `applications` space.
  - `tinycloud knowledge list` lists the apps that have a knowledge bundle (`<app_id>/knowledge/index.md`) with their concept files, merging the account application registry when the session can read it. `tinycloud knowledge read <app_id> [concept]` returns the index (with its links) or one concept with its frontmatter parsed. A grant that does not cover the request exits 5 and the hint lists the requests to make, with the real app id; a mistyped app id or concept exits 2 with the reason. Operations `tinycloud.knowledge.list@1` and `tinycloud.knowledge.read@1`; MCP tools `tinycloud_knowledge_list` and `tinycloud_knowledge_read` (local and hosted). Files and names come from the user's space, so they are marked untrusted in the tool result and escaped in terminal output (`--json` stays exact).
  - `tinycloud auth request --preset apps-agent` asks for **read-only** access: KV get and list, SQL read, on the `applications` space, up to 7 days. `--app <app_id>` (repeatable, up to 5) limits it to those apps' `<app_id>/` prefixes, which is the recommended ask. `--preset apps-agent --write --app <app_id>` is a separate opt-in for the named apps: KV put only in each app's `knowledge/` and `prefs/` folders (the folders the sample apps' manifests write to) plus SQL write, which adds, changes and deletes rows. Creating, changing and dropping tables also needs `tinycloud.sql/schema`, which the preset grants only on an app's catalog database (`xyz.tinycloud.sample.healthlog` gets `healthlog`, at the exact path `<app_id>/healthlog`). Everything else under `<app_id>/` stays read-only, so the app's code and its stored `<app_id>/app/manifest.json` and `<app_id>/app/install.json` cannot be changed through it (the root-level `<app_id>/manifest.json` and `<app_id>/install.json` are refused too) (TC-1620); it is refused without `--app`. Neither variant carries KV delete, SQL admin, schema on any other database, another service or space. The preset cannot be combined with `--cap`, `--permission`, `--manifest` or `--expiry`, and `--device` is refused because device approval cannot grant SQL.
  - `tinycloud auth grant` now resolves the request file once, the way the signer reads it (an entry with no `space` is in the owner's `applications` space; an empty space is refused; entries with the same service, space and path are merged), and prints, gates and signs that one list. Before signing it prints every permission in plain words (service, space, path, actions; delegation abilities as "can give other people or agents access on your behalf" and "can cancel access you gave"; unknown services and actions raw and marked unrecognised), once each, with the requested lifetime. The preset wording appears only when the permissions, the owner's own `applications` space and the 7-day lifetime all match. For a request that touches an `applications` space, anything the preset could never grant is marked `!`, listed first under "MORE than the apps-agent preset" and signed only after `--yes` or an interactive confirmation; without a terminal it exits 2 and signs nothing. A request with the `tinycloud.vault` shorthand, a service the signer cannot sign, or more than one space is refused with exit 2 before anything is printed or signed. The request's `sessionDid` and `requestedExpiry` are checked before anything is printed. Text from the request is escaped in the listing, the interactive prompt and every error message: on a terminal, `outputError` now escapes control characters, ANSI, bidi and zero-width characters (U+200B-200F, U+202A-202E, U+2066-2069, U+2028/2029, C1, U+FEFF) in every message and hint for every command. JSON output (stdout and the JSON error form on stderr, which a redirected `auth grant req.json > grant.json` still prints to a terminal) writes those characters as `\uXXXX` escapes: it parses to the same text. Refusal messages echo at most 5 items of 80 characters.
  - The `tc-cli` skill has a "Pick up a user's apps" section.
  - Fix: a delegation signed with an empty path (`tinycloud.kv:applications::get,list`, the whole service in a space) was rejected on import by the runtime validator, and `delegation revoke` could not bind its space. Both now accept it; other malformed resources are still refused. The validator now uses one pattern for both resource forms and drops an unreachable branch, so the web-sdk root bundle does not grow.

- 86815bd: Replica erase and purge refuse a symlinked or replaced identity, `replicas/` or replica directory, leaving the purge intent queued, and remove a leftover replica directory without a database only when it holds the store's own files, without recursion.
- e7f709d: Sign-in skips the background account registry sync when the session's signed ReCap does not cover the account index read (`tinycloud.sql/read` on the owner's `account` space, `account` database). A scoped session, such as a replica-enabled CLI OpenKey login, no longer sends a request that is always refused with 401 and logs an "account index initialization failed" warning. A session with no parseable ReCap still syncs as before.
- 94566db: Replication: the structural replica contract recognises the `REPLICA_GATED`, `STORAGE_BUDGET` and `CONSENT_EXPIRED` error codes. Types only; behaviour is unchanged.
- 41e5fca: A pending persisted-session restore or delegation activation no longer resumes after `signOut()` if it was waiting for storage or SDK initialization. The signed-out session stays inactive, and a later explicit sign-in can start a new session. If replacement session-key creation fails during sign-out, the node still retires the old authority and clears its persisted session.
- a7cdfe0: sdk-services adds the Node/CLI profile-facade contract types for deferred revoke and exact-inventory logout markers: `ProfileReplicaPurge`, `ProfileReplicaLogoutPending` (with a v1 `deniedEpoch`), `ProfileReplicaRemoteLogoutState`, `ProfileReplicaPreflight` and the inventory identity types. A new `typecheck:contract` script compiles their type assertions. CONTRACT.md specifies the logout behaviour the CLI logout implementation will deliver, including deny-first ordering, completion of an interrupted denial and the two-command inventory approval. This release ships types and specification only; no runtime behaviour changes, and browser lifecycle contracts are unchanged.

  node-sdk's `ProfileReplicaPurge` and `ProfileReplicaDeferredToken` are now derived from those contract types (the subset node-sdk implements), with the same shape as before.

- 94566db: Replication: enforce independently verified finite-expiration owner SIWE anchors with uncaveated KV get+sync coverage on the same verified scope in the exact space, bounded device-grant minting, and session-parent-only silent renewal. A `first_install` timestamp bounds expiry only; it cannot authorize minting. The controller uses the durable browser consent deadline for preflight, active timers, grant caps, and network fallback; compact restored sessions can only reuse a matching stamped, active installed grant with finite effective expiry while their current independently verified session still covers the requested prefix. A missing owner-backed compact proof fails closed, and session refusal never exposes installed local bytes or keys. Grant transitions use opaque replica IDs, including when a committed gate expiry beats the controller timer. The runtime subscribes only while its stamped controller is bound and detaches on rebind or close. Adds pure grant-lifetime policy helpers and validates `replication.grantTtlMs` (positive, at most 7 days).

  Browser boot bounds replica recovery before constructing the node. Failed or timed-out recovery gates local admission without breaking the network session; explicit sign-out still reaches the real lifecycle denial. The root web bundle remains inert with replication off; `@tinycloud/web-sdk/replica` exports a pure optional plugin and async IndexedDB factory loader. Applications register that plugin once with root `registerBrowserReplica` before constructing an enabled client, so test fixtures can inject a scheduler into the same root-owned runtime registry without a public clock option.

  Browser sign-in selects the connected wallet's persisted session. Explicit restore retains valid network authority for a different or unknown wallet, but refuses replica stamp admission; local reads recheck the provider account before returning cached bytes or keys.

  The runtime binds pending writes to the supplied lifecycle stamp and creates a fresh pending store when the stamp changes; gated storage cannot fall back to volatile pending memory. Replica opens carry the configured quota alongside the stamped grant policy. When a shorter grant policy expires before the immutable seven-day gate, get/list use the network and report `GRANT_EXPIRED`; only gate expiry causes `CONSENT_EXPIRED` and scoped denial. Rejected offline network fallbacks retain their network error and emit one `replication.read` error with the gate or current-session refusal reason; no local bytes are returned.

- 94566db: Expose a post-commit browser consent-expiry subscription for bound replication controllers. Recover expired origin keys before a direct replica open so a browser closed at the deadline cannot serve local data on return. Keep the web bundle replica-free by importing grant TTL policy from the narrow policy entry.
- ef9653b: Sign the share delivery authorization with the primary session key. The node records the signer as the delivery's sender key, and the SDK binds and countersigns the receipt with the primary session key; when a runtime grant held by another key covered the shared file, `tc share publish --to <email> --notify` rejected its own receipt and the recipient was never emailed (exit 9, `partial-failure`).
- 370a8e4: `TinyCloudWeb.signOut()` now ends the session on the instance, through the new `TinyCloudNode.signOut()`: session accessors return `undefined`, the session key is replaced, pending requests are aborted, and service calls fail instead of acting for the signed-out user. A sign-in or restore still in progress when sign-out is called does not establish its session; a later `signIn()` or `restoreSession()` starts a fresh one.

  `useDelegation()` results now belong to the session that created them: they stop working when that session signs out or is replaced by another `signIn()` or `restoreSession()`.

- ef49c14: The "Manage storage" link in storage-full errors and status now points to https://account.tinycloud.xyz/storage instead of /billing. The `tinycloud account billing` commands still open the billing page.

  Details: TC-848

- e99a127: Replication: enforce `maxBytes` on node/CLI replica storage. A page is admitted inside the guarded commit, before any write; when the profile's stored content plus the page's new blob bytes would exceed the budget, the page is refused with `STORAGE_BUDGET` and nothing is committed. Admission charges a page its net bytes (replaced or deleted content is credited) against the content actually on disk, and orphaned blobs are collected inside the same hold so on-disk content stays within the budget. `maxBytes` bounds the committed replica content (blob bytes); during a page commit the previous blobs of replaced entries remain until the commit completes, so on-disk bytes can transiently reach cap + bytes replaced by the page; the database file, WAL, rows and the pending store are not counted. Orphaned blobs left by a crash are collected on open, under the profile guard. Without `maxBytes`, storage behaves as before.
- 18b6c9f: `delegateTo`, `createDelegation` and `space.delegations.create` now throw for `disableSubDelegation: true` addressed to a `did:pkh` recipient, before anything is signed. A wallet-mode `useDelegation` of a terminal grant is refused by the node (`terminal-parent-cannot-redelegate`), so the recipient could never use it. Grant the recipient's session-key DID instead, or drop the flag (TC-1448).

  What breaks: calls that passed `disableSubDelegation: true` with a `did:pkh` delegate (including an ENS name that resolves to one) used to return a grant the wallet recipient could not activate; they now throw.

- 2292db7: Vault compare-and-swap and opt-in address binding (TC-1432). Everything is additive; existing reads and writes behave as before.
  - `VaultEntry.etag`: the node's strong ETag of the stored envelope. `readNetworkEncrypted` always returns it; `vault.get` returns it only with `source: "network"`, never from a replica (a replica can serve a stale etag). Network-encrypted vaults only.
  - `VaultPutOptions.ifMatch`: write only while the stored envelope still has that etag, passed exactly as read (quotes included); it cannot be combined with `ifNoneMatch`. A failed `ifMatch` write has its own code instead of `STORAGE_ERROR`: `ETAG_MISMATCH` (412, including a deleted or never-written key; re-read and retry), `INVALID_ETAG` (a weak, unquoted or otherwise malformed etag, refused locally or by the node's 400; never retry), `OUTCOME_UNKNOWN` (500 `outcome_unknown`, or a connection that failed with no response: the write may have been applied, so re-read before retrying and sign a fresh request) and `NODE_BUSY` (503, nothing written). Writes without `ifMatch` keep their current error mapping. `readSecret` maps the new `aad_mismatch` status to `read_failed`.
  - `VaultGetOptions.expectAad` (default off): refuse an envelope whose AAD is not `tinycloud.vault:<spaceId>:<key>` for the vault's own space and key. The space id is compared after lowercasing its EVM addresses, so a checksummed and a lowercase spelling are the same space. A mismatch, including an envelope written with no AAD, fails with `AAD_MISMATCH` (`get`) or `{ status: "aad_mismatch" }` (`readNetworkEncrypted`) before any decrypt request. This rejects a ciphertext copied to another key; it does not stop a freshly encrypted forgery. `getShared` is unchanged.

- Updated dependencies [c92953f]
- Updated dependencies [d2ad845]
- Updated dependencies [6ad58de]
- Updated dependencies [29440be]
- Updated dependencies [9592d3d]
- Updated dependencies [4aae658]
- Updated dependencies [4ac7592]
- Updated dependencies [fc88c48]
- Updated dependencies [38980b0]
- Updated dependencies [a7cdfe0]
- Updated dependencies [7578ee6]
- Updated dependencies [94566db]
- Updated dependencies [94566db]
- Updated dependencies [94566db]
- Updated dependencies [86815bd]
- Updated dependencies [2d491f0]
- Updated dependencies [94566db]
- Updated dependencies [9891ed9]
- Updated dependencies [94566db]
- Updated dependencies [86815bd]
- Updated dependencies [ac612c0]
- Updated dependencies [87a137e]
- Updated dependencies [370a8e4]
- Updated dependencies [ef49c14]
- Updated dependencies [5827d70]
- Updated dependencies [90bc0ae]
- Updated dependencies [cce8b26]
- Updated dependencies [eb9defd]
- Updated dependencies [0c4c6b2]
- Updated dependencies [baca422]
- Updated dependencies [8c95ddd]
- Updated dependencies [e99a127]
- Updated dependencies [f97d73d]
- Updated dependencies [2292db7]
  - @tinycloud/sdk-core@3.3.0
  - @tinycloud/node-sdk-wasm@1.7.8
  - @tinycloud/replica@0.3.0
  - @tinycloud/sdk-services@3.3.0

## 3.3.0-beta.39

### Patch Changes

- ef49c14: The "Manage storage" link in storage-full errors and status now points to https://account.tinycloud.xyz/storage instead of /billing. The `tinycloud account billing` commands still open the billing page.

  Details: TC-848

- Updated dependencies [ef49c14]
  - @tinycloud/sdk-services@3.3.0-beta.39
  - @tinycloud/replica@0.3.0-beta.11
  - @tinycloud/sdk-core@3.3.0-beta.39

## 3.3.0-beta.38

### Patch Changes

- @tinycloud/sdk-core@3.3.0-beta.38

## 3.3.0-beta.37

### Patch Changes

- Updated dependencies [4ac7592]
  - @tinycloud/sdk-core@3.3.0-beta.37

## 3.3.0-beta.36

### Patch Changes

- Updated dependencies [9592d3d]
  - @tinycloud/sdk-core@3.3.0-beta.36

## 3.3.0-beta.35

### Patch Changes

- Updated dependencies [2d491f0]
  - @tinycloud/replica@0.3.0-beta.10

## 3.3.0-beta.34

### Patch Changes

- a553392: Agents can pick up the apps a user installed, from their `applications` space.
  - `tinycloud knowledge list` lists the apps that have a knowledge bundle (`<app_id>/knowledge/index.md`) with their concept files, merging the account application registry when the session can read it. `tinycloud knowledge read <app_id> [concept]` returns the index (with its links) or one concept with its frontmatter parsed. A grant that does not cover the request exits 5 and the hint lists the requests to make, with the real app id; a mistyped app id or concept exits 2 with the reason. Operations `tinycloud.knowledge.list@1` and `tinycloud.knowledge.read@1`; MCP tools `tinycloud_knowledge_list` and `tinycloud_knowledge_read` (local and hosted). Files and names come from the user's space, so they are marked untrusted in the tool result and escaped in terminal output (`--json` stays exact).
  - `tinycloud auth request --preset apps-agent` asks for **read-only** access: KV get and list, SQL read, on the `applications` space, up to 7 days. `--app <app_id>` (repeatable, up to 5) limits it to those apps' `<app_id>/` prefixes, which is the recommended ask. Don't request `--write` during the tiny-apps beta. It currently also allows changes to the app's own code and manifest; the narrowed write ships in TC-1620. (The flag adds KV put and SQL write for the named apps and is refused without `--app`.) Because of how TinyCloud permissions work today, SQL write also lets the agent create, change or drop those apps' tables, and the scope text says so; TC-1581 (node-side: `sql/write` must not permit DDL) is the real cure. Neither variant carries KV delete, SQL admin or schema, another service or space. The preset cannot be combined with `--cap`, `--permission`, `--manifest` or `--expiry`, and `--device` is refused because device approval cannot grant SQL.
  - `tinycloud auth grant` now resolves the request file once, the way the signer reads it (an entry with no `space` is in the owner's `applications` space; an empty space is refused; entries with the same service, space and path are merged), and prints, gates and signs that one list. Before signing it prints every permission in plain words (service, space, path, actions; delegation abilities as "can give other people or agents access on your behalf" and "can cancel access you gave"; unknown services and actions raw and marked unrecognised), once each, with the requested lifetime. The preset wording appears only when the permissions, the owner's own `applications` space and the 7-day lifetime all match. For a request that touches an `applications` space, anything the preset could never grant is marked `!`, listed first under "MORE than the apps-agent preset" and signed only after `--yes` or an interactive confirmation; without a terminal it exits 2 and signs nothing. A request with the `tinycloud.vault` shorthand, a service the signer cannot sign, or more than one space is refused with exit 2 before anything is printed or signed. The request's `sessionDid` and `requestedExpiry` are checked before anything is printed. Text from the request is escaped in the listing, the interactive prompt and every error message: on a terminal, `outputError` now escapes control characters, ANSI, bidi and zero-width characters (U+200B-200F, U+202A-202E, U+2066-2069, U+2028/2029, C1, U+FEFF) in every message and hint for every command. JSON output (stdout and the JSON error form on stderr, which a redirected `auth grant req.json > grant.json` still prints to a terminal) writes those characters as `\uXXXX` escapes: it parses to the same text. Refusal messages echo at most 5 items of 80 characters.
  - The `tc-cli` skill has a "Pick up a user's apps" section.
  - Fix: a delegation signed with an empty path (`tinycloud.kv:applications::get,list`, the whole service in a space) was rejected on import by the runtime validator, and `delegation revoke` could not bind its space. Both now accept it; other malformed resources are still refused. The validator now uses one pattern for both resource forms and drops an unreachable branch, so the web-sdk root bundle does not grow.

## 3.3.0-beta.33

### Patch Changes

- Updated dependencies [8c95ddd]
  - @tinycloud/replica@0.3.0-beta.9

## 3.3.0-beta.31

### Patch Changes

- Updated dependencies [6ad58de]
  - @tinycloud/sdk-core@3.3.0-beta.31
  - @tinycloud/node-sdk-wasm@1.7.8-beta.0

## 3.3.0-beta.30

### Patch Changes

- Updated dependencies [fc88c48]
  - @tinycloud/sdk-core@3.3.0-beta.30

## 3.3.0-beta.29

### Patch Changes

- e99a127: Replication: enforce `maxBytes` on node/CLI replica storage. A page is admitted inside the guarded commit, before any write; when the profile's stored content plus the page's new blob bytes would exceed the budget, the page is refused with `STORAGE_BUDGET` and nothing is committed. Admission charges a page its net bytes (replaced or deleted content is credited) against the content actually on disk, and orphaned blobs are collected inside the same hold so on-disk content stays within the budget. `maxBytes` bounds the committed replica content (blob bytes); during a page commit the previous blobs of replaced entries remain until the commit completes, so on-disk bytes can transiently reach cap + bytes replaced by the page; the database file, WAL, rows and the pending store are not counted. Orphaned blobs left by a crash are collected on open, under the profile guard. Without `maxBytes`, storage behaves as before.
- Updated dependencies [e99a127]
  - @tinycloud/replica@0.3.0-beta.8

## 3.3.0-beta.28

### Patch Changes

- Updated dependencies [ac612c0]
  - @tinycloud/sdk-core@3.3.0-beta.28

## 3.3.0-beta.27

### Patch Changes

- Updated dependencies [4aae658]
  - @tinycloud/sdk-core@3.3.0-beta.27

## 3.3.0-beta.26

### Patch Changes

- Updated dependencies [7578ee6]
  - @tinycloud/replica@0.3.0-beta.7

## 3.3.0-beta.25

### Minor Changes

- 87a137e: Retry node `NODE_BUSY` and `REQUEST_TIMEOUT` answers automatically. Both mean nothing was applied, so the services now retry them under the existing `retryPolicy` through the new `ServiceContext.invokeWithRetry(url, build)`, which calls `build` once per attempt so every attempt carries a freshly signed invocation (the node answers a repeated invocation with 409, so re-sending one could never succeed). `ServiceContext.fetch` itself no longer retries. A context without `invokeWithRetry` sends once. The policy: at most 4 attempts in about 12 s, honouring the node's `Retry-After` (capped at the remaining budget) and otherwise backing off exponentially with full jitter (250 ms base, 4 s cap). Aborts and per-request timeouts end the wait at once, and `OUTCOME_UNKNOWN` is never retried. `defaultRetryPolicy` changes accordingly (its retryable codes are now `NODE_BUSY` and `REQUEST_TIMEOUT`; `NETWORK_ERROR` and `TIMEOUT` are no longer listed because no service read them), and `RetryPolicy` gains an optional `maxTotalMs`. Opt out with `retryPolicy: { maxAttempts: 1 }`.

  The CLI gains `--no-retry` and `TINYCLOUD_RETRY=0` for monitors and probes that must see the node's honest `NODE_BUSY`. KV responses (and `tc kv get|put|delete --json`) report `attempts` and `backoffMs`.

### Patch Changes

- Updated dependencies [87a137e]
  - @tinycloud/sdk-services@3.3.0-beta.25
  - @tinycloud/replica@0.3.0-beta.6
  - @tinycloud/sdk-core@3.3.0-beta.25

## 3.3.0-beta.24

### Patch Changes

- b6d0b9f: `tc account` commands now exit with `ACCOUNT_ACCESS_REQUIRED` (exit 5) before calling the node when the session lacks the account-space abilities that command invokes, as with a plain OpenKey login. Each command checks its own set (registry reads and writes, `kv/del` for removals, `space/list` and `capabilities/read` on the primary space for the commands that list spaces or delegations). `account delegations revoke` needs no session ability on a local-key profile (it signs with the owner wallet) and is refused with the `tc delegation revoke` command on an OpenKey profile, which cannot carry the raw-CID revoke ability, and the error prints the `tc auth request --grant --cap ...` command that grants exactly those, with a `--paste` variant. `tc auth request --grant` gains `--paste` (OpenKey owner profiles) for browsers that cannot reach the CLI's loopback callback, and a grant that spans several spaces now says up front how many OpenKey approvals it takes (one per space) and numbers each prompt. The account registry sync skip is recorded once per process as a debug event only (`TinyCloud_debug=true`).

## 3.3.0-beta.23

### Minor Changes

- d2ad845: `tc delegation create` now signs and activates the delegation through `delegateTo`, reads it back through the node's account delegation query, and prints its CID only once the node lists it as active (`DELEGATION_NOT_CONFIRMED` otherwise). `tc delegation list` and `tc delegation info` use that query (`POST /delegation/query`) via `account.delegations.query()`, which includes delegations signed by the session key; `list` gains `--space`, and `--to` accepts a `did:key` with a `#fragment`. Previously `create` and `list` sent `tinycloud.delegation/create` and `tinycloud.delegation/list` invocations that the node does not handle (it answered an empty 200, surfaced as a JSON parse error), and `info` called a method that did not exist.

  A plain `tc auth login` now also requests `tinycloud.delegation/list` on the default space (OpenKey's default grant omits it). A session that lacks it, on the account space and its own space, gets a `PERMISSION_DENIED` error saying to run `tc auth login` again. `DelegationManager.query()` signs for the account space and falls back to the session's own space when the node refuses (403).

  Breaking: removed `DelegationManager.create()` (use `TinyCloudNode.delegateTo()`), `DelegationManager.list()` (use `account.delegations.query()`), `TinyCloudNode.delegate()` (use `delegateTo()`), `TinyCloudNode.listDelegations()` (use `account.delegations.query()`), and the web-sdk `TinyCloudWeb.delegate()` (use `delegateTo()`) and `TinyCloudWeb.listDelegations()` (use `account.delegations.query()`). They sent invocations the node never handled, so they never worked. `account.delegations.list()` is not a replacement: it reads the SQL index and omits session-signed delegations. Also removed the `delegationManager` option from `SharingService` config; sharing uses `createDelegation` or `createDelegationWasm`.

  `TinyCloudNode.delegateTo()` takes a new `requireActivation` option: when set, it throws when the node answers 200 but lists a target space under `skipped` (a space it does not host), naming that space; this used to look like success. It is off by default, since grants to a not-yet-hosted space (e.g. secrets) are valid. `tc delegation create` sets it. `DelegationManager.getChain()` and `checkPermission()` now return an `UNSUPPORTED_OPERATION` error when the node answers with an empty body.

### Patch Changes

- Updated dependencies [d2ad845]
  - @tinycloud/sdk-core@3.3.0-beta.23

## 3.3.0-beta.22

### Patch Changes

- @tinycloud/sdk-core@3.3.0-beta.22

## 3.3.0-beta.21

### Patch Changes

- @tinycloud/sdk-core@3.3.0-beta.21

## 3.3.0-beta.20

### Minor Changes

- cce8b26: Add an opt-in `registryPolicy: "fail-closed"` for host resolution and automatic space creation (TC-1443). The default does not change.

  **Default (`"legacy-fallback"`, deprecated).** Sign-in resolves hosts exactly as before: when the location registry has no record or cannot be reached, the session silently uses the fallback host (`https://node.tinycloud.xyz` unless `tinycloudFallbackHosts` says otherwise). The first time a process takes that fallback it logs one `console.warn`; the fallback will be removed in a future major release. The default policy adds no registry request anywhere and no space-creation check.

  **`registryPolicy: "fail-closed"`** (`TinyCloudNodeConfig`, `NodeUserAuthorizationConfig`, web `Config`):
  - Sign-in without a configured host looks up the signer address in the registry first and acts on the three-state verdict. `registered`: the record's hosts, in record order. `unregistered`: `newUserHost` (default `https://node.tinycloud.xyz`; `null` refuses unregistered owners with `NodeNotFoundError`). `unavailable` (unreachable, timeout, bad status, oversize or malformed body, bad signature, a sequence below the remembered one, a not-found after a registration was seen, a failed read of the remembered sequence, or no registry configured): `RegistryUnavailableError`, never the new-user host. A record with no usable host is `NodeNotFoundError`. `newUserHost` governs routing only; a pinned host may still create spaces for an unregistered owner.
  - One host-scheme rule: hosts from a signed record are used for routing and for space creation only if they are HTTPS or HTTP on loopback, the same rule as `newUserHost` and `use-host`. The default policy is unchanged.
  - Local discovery probes the configured `localNodeUrl` / `localLinkName` and `*.local.tinycloud.link` hosts from a `registered` verdict; it no longer reads the registry itself, so an older or invalid record cannot route a session.
  - The lookup key is the signer address, never the session chain. The v1 registry keys records on an exact `did:pkh:eip155:<chain>:<EIP-55 address>`, so v1 lookups use `registryOwnerSubjectV1(address, registryChainId)` (`registryChainId` default 1). Registry v2 will key on the address alone.
  - `onNodeNotFound({ error, attempt })` decides what sign-in does instead of throwing: `{ action: "retry" }`, `{ action: "use-host", host }` (an HTTPS or loopback HTTP origin) or `{ action: "abort" }`. The SDK does not verify a `use-host` host's identity, and the choice persists with the session like any resolved host.
  - Automatic space creation is guarded: `ensureSpaceExists` (before asking the creation handler), account bootstrap host steps, sign-in's owned-space hosting, `ensureOwnedSpaceHosted`, and `ensurePublicSpace` (which the vault calls on unlock). Creating a space is refused with `NodeRegistryEntryExistsError` when the owner's registry record does not list the host (including a record with no hosts), and with `RegistryUnavailableError` when the registry gives no verdict. The space-creation handler's `onSpaceCreationFailed` receives the error. Pinned-host apps look the verdict up once, at creation. An explicit `hostOwnedSpace()` call is not guarded.
  - The highest record sequence seen per owner is remembered in `registrySequenceStore` (default in memory; web-sdk defaults to `localStorage` under `tinycloud.registrySequences.v1`). A failed write (full or read-only storage) logs one warning and keeps the verdict in hand, and the `localStorage` store still remembers the sequence for the page. A failed read or a corrupt stored value fails that lookup closed; remove the key to reset.

  New sdk-core exports: `resolveOwnerHosts`, `lookupOwnerRegistryVerdict`, `resolveFailClosedTinyCloudHosts`, `assertSpaceCreationAllowed`, `registryOwnerSubjectV1`, `createInMemoryRegistrySequenceStore`, `createLocalStorageRegistrySequenceStore`, the errors `NodeNotFoundError` (`code: "node_not_found"`), `RegistryUnavailableError` (`"registry_unavailable"`) and `NodeRegistryEntryExistsError` (`"node_registry_entry_exists"`), their option and callback types, and `DEFAULT_NEW_USER_HOST`, `DEFAULT_REGISTRY_OWNER_CHAIN_ID`, `DEFAULT_REGISTRY_LOOKUP_TIMEOUT_MS` (3 s) and `DEFAULT_REGISTRY_SEQUENCE_STORAGE_KEY`. Match errors on `error.code`: web-sdk bundles its own sdk-core, so `instanceof` against an app's separate sdk-core copy does not hold.

### Patch Changes

- Updated dependencies [cce8b26]
  - @tinycloud/sdk-core@3.3.0-beta.20

## 3.3.0-beta.18

### Patch Changes

- Updated dependencies [eb9defd]
  - @tinycloud/sdk-core@3.3.0-beta.18

## 3.3.0-beta.17

### Patch Changes

- @tinycloud/sdk-core@3.3.0-beta.17

## 3.3.0-beta.16

### Patch Changes

- 18b6c9f: `delegateTo`, `createDelegation` and `space.delegations.create` now throw for `disableSubDelegation: true` addressed to a `did:pkh` recipient, before anything is signed. A wallet-mode `useDelegation` of a terminal grant is refused by the node (`terminal-parent-cannot-redelegate`), so the recipient could never use it. Grant the recipient's session-key DID instead, or drop the flag (TC-1448).

  What breaks: calls that passed `disableSubDelegation: true` with a `did:pkh` delegate (including an ENS name that resolves to one) used to return a grant the wallet recipient could not activate; they now throw.

## 3.3.0-beta.15

### Patch Changes

- @tinycloud/sdk-core@3.3.0-beta.15

## 3.3.0-beta.14

### Patch Changes

- @tinycloud/sdk-core@3.3.0-beta.14

## 3.3.0-beta.13

### Patch Changes

- @tinycloud/sdk-core@3.3.0-beta.13

## 3.3.0-beta.11

### Patch Changes

- 2292db7: Vault compare-and-swap and opt-in address binding (TC-1432). Everything is additive; existing reads and writes behave as before.
  - `VaultEntry.etag`: the node's strong ETag of the stored envelope. `readNetworkEncrypted` always returns it; `vault.get` returns it only with `source: "network"`, never from a replica (a replica can serve a stale etag). Network-encrypted vaults only.
  - `VaultPutOptions.ifMatch`: write only while the stored envelope still has that etag, passed exactly as read (quotes included); it cannot be combined with `ifNoneMatch`. A failed `ifMatch` write has its own code instead of `STORAGE_ERROR`: `ETAG_MISMATCH` (412, including a deleted or never-written key; re-read and retry), `INVALID_ETAG` (a weak, unquoted or otherwise malformed etag, refused locally or by the node's 400; never retry), `OUTCOME_UNKNOWN` (500 `outcome_unknown`, or a connection that failed with no response: the write may have been applied, so re-read before retrying and sign a fresh request) and `NODE_BUSY` (503, nothing written). Writes without `ifMatch` keep their current error mapping. `readSecret` maps the new `aad_mismatch` status to `read_failed`.
  - `VaultGetOptions.expectAad` (default off): refuse an envelope whose AAD is not `tinycloud.vault:<spaceId>:<key>` for the vault's own space and key. The space id is compared after lowercasing its EVM addresses, so a checksummed and a lowercase spelling are the same space. A mismatch, including an envelope written with no AAD, fails with `AAD_MISMATCH` (`get`) or `{ status: "aad_mismatch" }` (`readNetworkEncrypted`) before any decrypt request. This rejects a ciphertext copied to another key; it does not stop a freshly encrypted forgery. `getShared` is unchanged.

- Updated dependencies [2292db7]
  - @tinycloud/sdk-services@3.3.0-beta.11
  - @tinycloud/replica@0.3.0-beta.5
  - @tinycloud/sdk-core@3.3.0-beta.11

## 3.3.0-beta.10

### Patch Changes

- @tinycloud/sdk-core@3.3.0-beta.10

## 3.3.0-beta.9

### Patch Changes

- ef9653b: Sign the share delivery authorization with the primary session key. The node records the signer as the delivery's sender key, and the SDK binds and countersigns the receipt with the primary session key; when a runtime grant held by another key covered the shared file, `tc share publish --to <email> --notify` rejected its own receipt and the recipient was never emailed (exit 9, `partial-failure`).

## 3.3.0-beta.8

### Minor Changes

- f97d73d: `disableSubDelegation: true` now sets the node's terminal marker (the UCAN fact `xyz.tinycloud.policy/delegationMode: "terminal"`), so the node refuses any delegation that cites the result as a parent. It applies to `createDelegation`, the `space.delegations.create` wiring, and the new `delegateTo` option of the same name; the returned delegation reports `disableSubDelegation: true`. sdk-core exports `TERMINAL_DELEGATION_FACT` and `markDelegationTerminal` (TC-1436).

  Behaviour change, released as `minor` because the repository's versioning rule allows agents only `minor` or `patch` (a major needs a maintainer's sign-off). What breaks:
  - `disableSubDelegation: true` now throws instead of issuing a wallet-signed delegation that can still be re-delegated: in `createSubDelegation`, in `delegateTo` with `forceWalletSign`, and in `createDelegation` when the requested capabilities are outside the current session.
  - A terminal delegation still works for a delegate that uses it directly, but a wallet-mode `useDelegation`, which chains a new session from it, is refused by the node.

### Patch Changes

- Updated dependencies [f97d73d]
  - @tinycloud/sdk-core@3.3.0-beta.8

## 3.3.0-beta.7

### Minor Changes

- 38980b0: Stamp replica sessions only from a fully verified owner SIWE with finite signed expiry and exact-space KV get+sync authority; missing proof refuses only the replica, not network sign-in. Restore validates the persisted stamp without repairing it. Browser IndexedDB sign-in, restore, and sign-out use its lifecycle without a Node profile directory; sign-out denies the gate and shreds replica keys. Replication-disabled sign-in does not inspect replica SIWE metadata.

  Node exports `createProfileReplicaPurge({ profileDir, guard })` for profile-locked CLI cleanup. A failed online revoke can durably deny local reads with `deny({ reason: "sign_out", principal }, { deferErase: true })` while retaining the network session, key, and replica files. The returned epoch/principal token resumes erasure after remote success; recovery leaves deferred files untouched and retries ordinary erasure after resume. `TinyCloudNode.signOut()` awaits durable denial before registry cleanup.
  `logoutPrincipalDigest(principal)` exposes the owner binding stored as a logout marker's `principalDigest` (advisory; not authority), so callers can check a marker against the current session before recovery.
  Node denial reads the gate snapshot and hashes the principal under the same profile lock as `denyGate`; partition and pending intents use that snapshot's salt. A gate established while denial waits for the lock is included rather than producing an empty-salt intent inventory.
  `ProfileReplica*` facade types now come from `@tinycloud/sdk-services/kv/replication`; Node SDK retains the runtime factory and marker exports without duplicate type declarations or aliases.
  Node direct sign-out and account-switch denial emits one `replication.lifecycle` event after a committed `denied`, `database_deleted`, or `marker_set` outcome to both `replication.onEvent` and the leaving service context. Stale and unguarded outcomes cannot claim a committed denial; the event carries no raw principal or space.

  CLI logout uses a profile-locked, fsynced opaque `replica-logout-pending.json` marker before deleting either `session.json` or `key.json`. CLI-bound replica reads, pending writes, restores, and already-open handles refuse while it exists. Startup recovery verifies the marker's gate incarnation/epoch/principal hash, commits full purge intents or resumes a deferred denial, removes and fsyncs both credentials, then removes the marker before retrying erase. Generic SQLite storage does not infer CLI session files; CLI callers opt in with `logoutPendingFile`. A successful remote revoke follows this same credential-shredding path; failed revoke keeps its deferred gate and credentials for retry. `recoverLogoutPending().remaining` counts durable intents only; `failed` or the marker indicates incomplete logout even when that count is zero. If writing the marker fails, an ordinary gate denial can still fence replica reads but cannot by itself recover a crash before credential unlink.
  For an active v1 plain logout, recovery commits the full generation-fenced denial and opaque intent inventory under the profile lock before calling `clearCredentials`. A denied gate write leaves the marker, both credentials, and replica files intact for retry. After a BUSY plain cleanup, reapproval recognizes that marker's same incarnation and next denied epoch with a null `deferredPrincipalHash`; the existing deferred-owner path remains intact. Remote-pending, successor, and stale markers remain fenced.

  `recoverLogoutPending` requires an idempotent `eraseLegacyReplicas` callback for the CLI's separate `<profile>/replicas` root. It runs only after the gate's full intent/generation commit, while the marker still blocks reads; the facade verifies the legacy root is gone and fsyncs the profile before clearing the marker. Failure or interruption retains the marker for retry. The callback must never delete S3's `<profile>/replication` root.
  On retry after a busy legacy SQLite lease, only source-created `replica.db-wal`, `replica.db-shm`, and `replica.db-journal` sidecars may be regenerated. Recovery still requires the originally approved database and replica directory identities; a path approved as unknown never acquires the known-sidecar exception.

  An inactive gate also gets an epoch-bound logout marker while opaque intents or legacy replicas remain. Recovery retains it until legacy-only cleanup completes; a successor gate cannot replay the old marker.

  An already-deferred v1 gate cannot mint a missing pre-denial logout marker or authorize remote revoke from its later denied epoch. Explicitly approved corrupt gates use a v2 orphan marker: after that marker is durable, the still-corrupt gate file is removed and fsynced before remote work; remote completion still requires the gate to be absent. Because that marker has no original gate-file identity, a later retry or reapproval never unlinks an unreadable gate; it fails closed with the marker and any not-yet-erased credentials or replica files intact until the gate is absent. Orphan recovery also refuses a newly corrupt or valid replacement gate before credential cleanup and again before marker removal; failures retain the marker for retry. Failed initial removal retains the marker and credentials.

  When the CLI profile's gate is missing or corrupt, scoped intents cannot be reconstructed. `prepareLogoutPending({ principal, discardLocalChanges? })` instead writes a distinct opaque orphan-profile marker before credential unlink. Without explicit `discardLocalChanges`, unsynced `pending.json` records, an unrecognized flag-owned layout, an unknown legacy child or SQLite schema, or a corrupt/unreadable gate refuse with sync-first/`--discard-local-changes` guidance. Recovery under the profile lock shreds and fsyncs both credentials, wipes only validated real `<profile>/replication` and `<profile>/replicas` roots, confirms absence and fsyncs the profile, then removes the marker. Root deletion failure leaves the marker; neither scoped intents nor a replacement gate are fabricated. CLI sign-in must check the marker before persisting a new session.

  The orphan wipe accepts the CLI lock's exact Linux `/proc/self/fd/<n>` directory pin as well as a real profile directory. It validates each replica root against that pinned directory, refuses arbitrary profile symlinks and closed pins even when roots are absent, and never redirects a wipe to a replacement profile-name symlink. With a missing gate, only a validated identity record plus an inspected empty `pending.json` and no other identity children prove a flag-owned partition has no unsynced writes; a missing index, replica files, device key, or unknown child format requires explicit discard.

  `TinyCloudNode.replicaStamp` exposes a defensive copy of the active verified stamp after sign-in or validated restore; sign-out clears it. `TinyCloudNode.signInWithOpenKey(authorizeFn, options?)` prepares the original SIWE before OpenKey approval and verifies the signed result through the existing authorization flow before committing the network session and replica stamp. The callback receives the SDK-prepared `verificationMethod` for local session-DID handoff, not as an OpenKey wire field. Optional `retryResult(error, originalRequest, attempt)` retries rejected callback transport or signed results against that same SIWE and key without retrying network activation.

  Prefix-scoped, uncaveated signed KV get+sync authority now anchors replica consent as well as root authority. Node SQLite reads pair rows with a fence captured before their SQLite snapshot. A CID's original grant installation time survives targeted partition purge; an expired effective grant refuses synchronization before transport and refuses a page that expires before commit.

- 0c4c6b2: `ProfileReplicaPurge.deny` with `{ deferErase: true }` now accepts only `reason: "sign_out"` and returns `ProfileReplicaDeferredDenyOutcome`, whose committed `denied` always carries `resumeToken`. `ReplicaEraseReport.deferred: true` marks a pass held by a deferred denial, so `remaining: 0` there is not completion. node-sdk exports the full contract `ProfileReplicaPurge`, requires the displayed `approval` in `prepareLogoutPending`, and reports `purgePending` from inspected status while a deferred denial or any intent remains.

  A v1 logout marker records the epoch its denial actually committed (`deniedEpoch`) in the same locked section as the deny, and every later check compares with it. A sign-out interrupted between its deny floor and gate writes is completed by the next `auth logout` (`@tinycloud/replica/profile-gate` adds `readLogoutGate`, `advanceInactiveGate` and `REPLICA_DENY_FLOOR_FILE`); reads report "a previous sign-out was interrupted; re-running `tc auth logout` completes it". A restored older gate under a recorded denial refuses with the `tc profile delete` route.

  `auth logout` by an account other than the one whose replicas the profile holds writes no marker and leaves that account's gate, floor and replicas untouched: it signs out, removes its own session and key, and erases the profile's legacy `replicas/` mirror (replayed at startup after a crash). `--revoke` there revokes only grants on the signed-in account's spaces.

  When startup recovery refuses a pending logout because a credential file is unreadable, the message now names that file (`session.json` or `profile.json`).

  CLI-bound storage and purge name the CLI's `replication/events.jsonl` and `events.jsonl.1` diagnostics logs (`diagnosticFiles`). With a readable gate, those exact names count as known only while they are regular files, so a fully synced profile signs out without `--discard-local-changes`; a symlink there stays unknown.

### Patch Changes

- 29440be: Wallet-backed `TinyCloudNode.revokeDelegation(cid)` now signs a direct owner revocation for the target CID. Session-only clients continue to use their delegated revocation authority; the node receipt must confirm the requested CID (TC-721, TC-821).
- 86815bd: Replica erase and purge refuse a symlinked or replaced identity, `replicas/` or replica directory, leaving the purge intent queued, and remove a leftover replica directory without a database only when it holds the store's own files, without recursion.
- e7f709d: Sign-in skips the background account registry sync when the session's signed ReCap does not cover the account index read (`tinycloud.sql/read` on the owner's `account` space, `account` database). A scoped session, such as a replica-enabled CLI OpenKey login, no longer sends a request that is always refused with 401 and logs an "account index initialization failed" warning. A session with no parseable ReCap still syncs as before.
- 94566db: Replication: the structural replica contract recognises the `REPLICA_GATED`, `STORAGE_BUDGET` and `CONSENT_EXPIRED` error codes. Types only; behaviour is unchanged.
- a7cdfe0: sdk-services adds the Node/CLI profile-facade contract types for deferred revoke and exact-inventory logout markers: `ProfileReplicaPurge`, `ProfileReplicaLogoutPending` (with a v1 `deniedEpoch`), `ProfileReplicaRemoteLogoutState`, `ProfileReplicaPreflight` and the inventory identity types. A new `typecheck:contract` script compiles their type assertions. CONTRACT.md specifies the logout behaviour the CLI logout implementation will deliver, including deny-first ordering, completion of an interrupted denial and the two-command inventory approval. This release ships types and specification only; no runtime behaviour changes, and browser lifecycle contracts are unchanged.

  node-sdk's `ProfileReplicaPurge` and `ProfileReplicaDeferredToken` are now derived from those contract types (the subset node-sdk implements), with the same shape as before.

- 94566db: Replication: enforce independently verified finite-expiration owner SIWE anchors with uncaveated KV get+sync coverage on the same verified scope in the exact space, bounded device-grant minting, and session-parent-only silent renewal. A `first_install` timestamp bounds expiry only; it cannot authorize minting. The controller uses the durable browser consent deadline for preflight, active timers, grant caps, and network fallback; compact restored sessions can only reuse a matching stamped, active installed grant with finite effective expiry while their current independently verified session still covers the requested prefix. A missing owner-backed compact proof fails closed, and session refusal never exposes installed local bytes or keys. Grant transitions use opaque replica IDs, including when a committed gate expiry beats the controller timer. The runtime subscribes only while its stamped controller is bound and detaches on rebind or close. Adds pure grant-lifetime policy helpers and validates `replication.grantTtlMs` (positive, at most 7 days).

  Browser boot bounds replica recovery before constructing the node. Failed or timed-out recovery gates local admission without breaking the network session; explicit sign-out still reaches the real lifecycle denial. The root web bundle remains inert with replication off; `@tinycloud/web-sdk/replica` exports a pure optional plugin and async IndexedDB factory loader. Applications register that plugin once with root `registerBrowserReplica` before constructing an enabled client, so test fixtures can inject a scheduler into the same root-owned runtime registry without a public clock option.

  Browser sign-in selects the connected wallet's persisted session. Explicit restore retains valid network authority for a different or unknown wallet, but refuses replica stamp admission; local reads recheck the provider account before returning cached bytes or keys.

  The runtime binds pending writes to the supplied lifecycle stamp and creates a fresh pending store when the stamp changes; gated storage cannot fall back to volatile pending memory. Replica opens carry the configured quota alongside the stamped grant policy. When a shorter grant policy expires before the immutable seven-day gate, get/list use the network and report `GRANT_EXPIRED`; only gate expiry causes `CONSENT_EXPIRED` and scoped denial. Rejected offline network fallbacks retain their network error and emit one `replication.read` error with the gate or current-session refusal reason; no local bytes are returned.

- 94566db: Expose a post-commit browser consent-expiry subscription for bound replication controllers. Recover expired origin keys before a direct replica open so a browser closed at the deadline cannot serve local data on return. Keep the web bundle replica-free by importing grant TTL policy from the narrow policy entry.
- Updated dependencies [29440be]
- Updated dependencies [38980b0]
- Updated dependencies [a7cdfe0]
- Updated dependencies [94566db]
- Updated dependencies [94566db]
- Updated dependencies [94566db]
- Updated dependencies [86815bd]
- Updated dependencies [94566db]
- Updated dependencies [94566db]
- Updated dependencies [86815bd]
- Updated dependencies [90bc0ae]
- Updated dependencies [0c4c6b2]
  - @tinycloud/sdk-core@3.3.0-beta.7
  - @tinycloud/replica@0.3.0-beta.4
  - @tinycloud/sdk-services@3.3.0-beta.7

## 3.2.6-beta.6

### Patch Changes

- Updated dependencies [5827d70]
  - @tinycloud/replica@0.2.4-beta.3

## 3.2.6-beta.5

### Patch Changes

- Updated dependencies [baca422]
  - @tinycloud/replica@0.2.4-beta.2

## 3.2.6-beta.4

### Patch Changes

- Updated dependencies [9891ed9]
  - @tinycloud/sdk-services@3.2.6-beta.4
  - @tinycloud/replica@0.2.4-beta.1
  - @tinycloud/sdk-core@3.2.6-beta.4

## 3.2.6-beta.3

### Patch Changes

- 41e5fca: A pending persisted-session restore or delegation activation no longer resumes after `signOut()` if it was waiting for storage or SDK initialization. The signed-out session stays inactive, and a later explicit sign-in can start a new session. If replacement session-key creation fails during sign-out, the node still retires the old authority and clears its persisted session.

## 3.2.6-beta.2

### Patch Changes

- 370a8e4: `TinyCloudWeb.signOut()` now ends the session on the instance, through the new `TinyCloudNode.signOut()`: session accessors return `undefined`, the session key is replaced, pending requests are aborted, and service calls fail instead of acting for the signed-out user. A sign-in or restore still in progress when sign-out is called does not establish its session; a later `signIn()` or `restoreSession()` starts a fresh one.

  `useDelegation()` results now belong to the session that created them: they stop working when that session signs out or is replaced by another `signIn()` or `restoreSession()`.

- Updated dependencies [370a8e4]
  - @tinycloud/sdk-services@3.2.6-beta.2
  - @tinycloud/replica@0.2.4-beta.0
  - @tinycloud/sdk-core@3.2.6-beta.2

## 3.2.6-beta.1

### Patch Changes

- Updated dependencies [c92953f]
  - @tinycloud/sdk-core@3.2.6-beta.1

## 3.2.6-beta.0

### Patch Changes

- 2aa917e: Sign account-only manifests into the account space they authorize, and expose the active authorization CID after restoring a persisted browser session.

## 3.2.5

### Patch Changes

- Updated dependencies [0b02662]
  - @tinycloud/sdk-services@3.2.5
  - @tinycloud/replica@0.2.3
  - @tinycloud/sdk-core@3.2.5

## 3.2.5-beta.0

### Patch Changes

- Updated dependencies [0b02662]
  - @tinycloud/sdk-services@3.2.5-beta.0
  - @tinycloud/replica@0.2.3-beta.0
  - @tinycloud/sdk-core@3.2.5-beta.0

## 3.2.4

### Patch Changes

- Updated dependencies [364a679]
  - @tinycloud/replica@0.2.2
  - @tinycloud/sdk-core@3.2.4
  - @tinycloud/sdk-services@3.2.4

## 3.2.4-beta.0

### Patch Changes

- Updated dependencies [364a679]
  - @tinycloud/replica@0.2.2-beta.0

## 3.2.3

### Patch Changes

- c13720c: `tc share revoke <id>` now revokes public (anyone-with-the-link) shares. Before, the node refused the revocation with 403 and the link stayed readable until it expired. The command reports `revoked` only when the node confirms it; receiving the link then fails.
  - **Error codes for bearer revokes.**
    - `SHARE_ISSUER_KEY_UNAVAILABLE` (exit 5): the profile cannot sign for the link. Nothing is revoked.
    - `SHARE_LINK_UNAVAILABLE` (exit 4): the stored link is missing, or it doesn't match the record. Nothing is revoked.
    - `SHARE_REVOKE_REJECTED` (exit 4): the node refused. The message includes the node's reason, and nothing is revoked.
    - `SHARE_REVOKE_UNCONFIRMED` (exit 1): the node answered without confirming. The link may already be revoked, history is not marked revoked, and you should check the link before retrying.
  - **History.** Revoking an already revoked share keeps its original `revokedAt`.
  - **Share SDK.** `ShareRevocationAdapter.revokeDelegation` now receives the share `record` next to `delegationCid` and `scope`, and `revokeShare` passes it. Adapters that ignore it still type-check, but code that calls `adapter.revokeDelegation(...)` directly must now pass `record`. `revokeShare` keeps an existing `revokedAt`.
  - **sdk-core.** These are additions only:
    - `parseSignedCompactUcanAttenuation` also returns the verified issuer as `payload.iss`.
    - The new `parseSignedSiweCacao(authorization, expectedCid?)` verifies a wallet SIWE CACAO: size (64 KiB) and nesting (64) limits, the exact-bytes CID, canonical DAG-CBOR, the CACAO shape (integer version 1, no unknown or empty fields, safe-integer chain ID), the ReCap shape and statement, and the EIP-191 signature. It returns the issuer, audience, `expiresAt` and the ReCap attenuation. It does not enforce validity times; callers decide.
  - **node-sdk.** The new `TinyCloudNode.signOwnerRevocation(cid)` signs a wallet (CACAO) revocation that the node's `POST /revoke` accepts from the space owner.

- Updated dependencies [c13720c]
  - @tinycloud/sdk-core@3.2.3
  - @tinycloud/sdk-services@3.2.3

## 3.2.3-beta.0

### Patch Changes

- c13720c: `tc share revoke <id>` now revokes public (anyone-with-the-link) shares. Before, the node refused the revocation with 403 and the link stayed readable until it expired. The command reports `revoked` only when the node confirms it; receiving the link then fails.
  - **Error codes for bearer revokes.**
    - `SHARE_ISSUER_KEY_UNAVAILABLE` (exit 5): the profile cannot sign for the link. Nothing is revoked.
    - `SHARE_LINK_UNAVAILABLE` (exit 4): the stored link is missing, or it doesn't match the record. Nothing is revoked.
    - `SHARE_REVOKE_REJECTED` (exit 4): the node refused. The message includes the node's reason, and nothing is revoked.
    - `SHARE_REVOKE_UNCONFIRMED` (exit 1): the node answered without confirming. The link may already be revoked, history is not marked revoked, and you should check the link before retrying.
  - **History.** Revoking an already revoked share keeps its original `revokedAt`.
  - **Share SDK.** `ShareRevocationAdapter.revokeDelegation` now receives the share `record` next to `delegationCid` and `scope`, and `revokeShare` passes it. Adapters that ignore it still type-check, but code that calls `adapter.revokeDelegation(...)` directly must now pass `record`. `revokeShare` keeps an existing `revokedAt`.
  - **sdk-core.** These are additions only:
    - `parseSignedCompactUcanAttenuation` also returns the verified issuer as `payload.iss`.
    - The new `parseSignedSiweCacao(authorization, expectedCid?)` verifies a wallet SIWE CACAO: size (64 KiB) and nesting (64) limits, the exact-bytes CID, canonical DAG-CBOR, the CACAO shape (integer version 1, no unknown or empty fields, safe-integer chain ID), the ReCap shape and statement, and the EIP-191 signature. It returns the issuer, audience, `expiresAt` and the ReCap attenuation. It does not enforce validity times; callers decide.
  - **node-sdk.** The new `TinyCloudNode.signOwnerRevocation(cid)` signs a wallet (CACAO) revocation that the node's `POST /revoke` accepts from the space owner.

- Updated dependencies [c13720c]
  - @tinycloud/sdk-core@3.2.3-beta.0

## 3.2.2

### Patch Changes

- Updated dependencies [a007d43]
  - @tinycloud/replica@0.2.1
  - @tinycloud/sdk-core@3.2.2
  - @tinycloud/sdk-services@3.2.2

## 3.2.2-beta.0

### Patch Changes

- Updated dependencies [a007d43]
  - @tinycloud/replica@0.2.1-beta.0

## 3.2.1

### Patch Changes

- 10359c5: `signIn()` no longer waits for the account-registry sync (TC-998). In 3.2.0, every app sign-in waited up to 4 s for it, and on production the sync never finished inside that window. The sync runs in the background again, as in 3.1.0, with a 30 s hang guard instead of the 4 s cap, so the app's registry record is written after sign-in. A new sign-in, or a successful `restoreSession()`, stops the replaced session's sync before swapping the session.

  `ensureOwnedSpaceHosted()` no longer waits for the sync, and no longer asks for a second `tinycloud.space/host` approval for a space that is already hosted (TC-994). It trusts the sign-in activation, which lists every hosted space the session covers, and the spaces this session has hosted, before it falls back to the registry record. Concurrent hosts of the same space, for example the background sync and the app, share one approval.

  Use the new `TinyCloudNode.waitForAccountRegistrySync()` when you need the registry written, or before a first write against a SQLite-backed node older than 1.20.2 (TC-899). Background sync failures are logged as warnings and never surface as unhandled rejections.

- eda1f78: Repeat Node and CLI sign-ins no longer re-run the full account bootstrap (TC-999). On Node, the bootstrap completion marker was stored as `text/plain` and read back as a string, so it was rejected and every login ran the repair (about 53 s on production). A string marker is now parsed as JSON before validation; invalid JSON or a marker of the wrong shape still means "not completed" and never throws. Markers already written as `text/plain` are accepted, so existing accounts skip on their next sign-in.
  - @tinycloud/sdk-core@3.2.1
  - @tinycloud/sdk-services@3.2.1

## 3.2.1-beta.1

### Patch Changes

- 10359c5: `signIn()` no longer waits for the account-registry sync (TC-998). In 3.2.0, every app sign-in waited up to 4 s for it, and on production the sync never finished inside that window. The sync runs in the background again, as in 3.1.0, with a 30 s hang guard instead of the 4 s cap, so the app's registry record is written after sign-in. A new sign-in, or a successful `restoreSession()`, stops the replaced session's sync before swapping the session.

  `ensureOwnedSpaceHosted()` no longer waits for the sync, and no longer asks for a second `tinycloud.space/host` approval for a space that is already hosted (TC-994). It trusts the sign-in activation, which lists every hosted space the session covers, and the spaces this session has hosted, before it falls back to the registry record. Concurrent hosts of the same space, for example the background sync and the app, share one approval.

  Use the new `TinyCloudNode.waitForAccountRegistrySync()` when you need the registry written, or before a first write against a SQLite-backed node older than 1.20.2 (TC-899). Background sync failures are logged as warnings and never surface as unhandled rejections.

## 3.2.1-beta.0

### Patch Changes

- eda1f78: Repeat Node and CLI sign-ins no longer re-run the full account bootstrap (TC-999). On Node, the bootstrap completion marker was stored as `text/plain` and read back as a string, so it was rejected and every login ran the repair (about 53 s on production). A string marker is now parsed as JSON before validation; invalid JSON or a marker of the wrong shape still means "not completed" and never throws. Markers already written as `text/plain` are accepted, so existing accounts skip on their next sign-in.

## 3.2.0

### Minor Changes

- 33efc8c: Export `siweRuntimeDelegation` to project an OpenKey signed-login (SIWE/ReCap CACAO) grant into a portable runtime delegation. A decrypt-only projection retains its owner space when the signed ReCap has no space entry.
- 26f86bd: TC-628: Storage status, one `storage.full` event, and no doomed writes on read paths.
  - Storage rejections read the node's JSON 402/413 body. `meta.usedBytes`/`meta.limitBytes` still describe the space, and `meta.account` carries `{ usedBytes, limitBytes, plan }` for the whole account when the node sends it. The old plain-text body still parses. SQL and DuckDB now report a storage 413 (the node's `storage_limit_reached` body or storage text) as `STORAGE_LIMIT_REACHED`, as KV already did; a 413 without it stays `*_RESPONSE_TOO_LARGE`.
  - `tc.on("storage.full", handler)` on `TinyCloudNode` and `TinyCloudWeb` fires once, on the first write any service has rejected for storage. The event carries the code, the space numbers, `account` and the rejected `spaceId`. It also goes through the service context's `emit` as `storage.full` (`TelemetryEvents.STORAGE_FULL`). Which owners are full is recorded per owner, so a full delegated space never hides that the signed-in account is full too. It fires again once `storage.status()` has reported room for every owner whose write was rejected, or after signing in or restoring a session whose primary space belongs to a different owner. Restoring the same owner with or without the optional address/SIWE metadata keeps the episode.
  - `tc.storage.status({ space? })` reads usage and plan from the node (`tinycloud.space/info`, TC-626) and returns `{ usedBytes, limitBytes, account, plan, state, manageUrl }`. `state` is `ok`, `nearly_full` (≥ 90%) or `full`, from the account totals when known, and `limitBytes: null` means unlimited. It needs `tinycloud.space/info` on that space, from the session recap or an installed runtime delegation. Default sessions do not request it yet. When the grant cannot be confirmed locally, it returns `PERMISSION_DENIED` and sends no request. A node without the usage read returns the new `STORAGE_STATUS_UNAVAILABLE` code.
  - While the signed-in account's storage is known full:
    - `spaces.list()` still lists, but does not register each listed space;
    - sign-in skips the bootstrap repair (`bootstrapStatus.reason: "storage-full"`);
    - sign-in skips the background account registry sync (index ensure, manifest records, space sync).

    These writes would only be refused again. A rejection on another owner's space does not stop them, and does not hide a later rejection on the account's own.

  - `SpaceServiceConfig` (and `SpaceServiceConfigSchema`) accepts `isStorageFull?: () => boolean`; when it returns true, `list()` skips `onSpaceRegistered`.
  - New exports:
    - functions and values: `parseStorageRejection`, `parseStorageStatus`, `storageUsageState`, `StorageFullMonitor` (per-owner: `isFullFor(spaceId)`, `clearFor(spaceId)`), `STORAGE_MANAGE_URL`, `STORAGE_NEARLY_FULL_RATIO`, and the error code `ErrorCodes.STORAGE_STATUS_UNAVAILABLE`;
    - types: `StorageStatus`, `StorageStatusOptions`, `StorageUsage`, `StorageUsageState`, `IStorageService`, `StorageFullEvent`, `StorageFullHandler`, `StorageAccountUsage` and `StorageRejectionDetails`.
  - Deprecated, still exported unchanged: `TinyCloudQuota`, `QuotaConfig`, `QuotaStatus` and `StorageQuotaInfo`. Use `storage.status()` and `on("storage.full")` instead.

- 4f851e6: Create-only secret writes, app-derived secret scopes, typed vault write errors, and classified delegation activation failures.
  - **New:** `appSecretScope(appId)` derives the canonical secret scope for an app id (`com.listen.app` → `com-listen-app`), with `SECRET_SCOPE_RE`, `MAX_SECRET_SCOPE_LENGTH` (64) and `TC832_RESERVED_SCOPES` exported from every SDK package.
  - **New:** `secrets.put(name, value, { ifAbsent: true })` (type `SecretPutOptions`) writes only when the secret does not exist. An existing secret fails with vault error `ALREADY_EXISTS` (KV 412; `meta.status` and the typed KV error as `cause`) and is never overwritten. `DataVaultService.put` accepts `{ ifNoneMatch: "*" }` for network-encrypted vaults; a legacy (key-blob) vault refuses it with `STORAGE_ERROR` before any KV call. The Node and Web secrets wrappers forward the option unchanged.
  - **New:** a refused vault write keeps its authorization classification. A refused write is `AUTH_UNAUTHORIZED` only for HTTP 401 (sign-in needed). A 403 is `PERMISSION_DENIED`. Both keep `meta.status` and the typed KV error as `cause`, so `validatedCapabilityOf` still finds the missing capability. Other failures stay `STORAGE_ERROR`, now with `meta` and the KV error chained as the cause.
  - **Fix:** KV `get`/`head`/`delete` now honour their timeout and abort signal while reading a 404 body that never finishes, instead of hanging; `createSignedReadUrl` error bodies get the same fix.
  - **New:** node-sdk classifies delegation activation failures. `useRuntimeDelegation` reports an unreachable host as an error with `code: "ACTIVATION_TRANSPORT_FAILED"`. `RuntimeDelegationRejection` gains `activation_unavailable` (transport failure, 408, 429, 5xx) and `activation_unauthenticated` (401); every other activation failure stays `activation_rejected`.

  **Breaks:**
  - Code that matched `STORAGE_ERROR` for a vault or secrets write refused by authorization now receives `AUTH_UNAUTHORIZED` (401) or `PERMISSION_DENIED` (403, or no status).
  - `VaultError`/`VaultErrorInput` gain the `ALREADY_EXISTS`, `AUTH_UNAUTHORIZED` and `PERMISSION_DENIED` variants, so exhaustive `switch`es over the vault error code need the new cases.
  - Code that enumerates `RuntimeDelegationRejection` / `RUNTIME_DELEGATION_REJECTIONS` sees two new reasons; activation failures that were `activation_rejected` may now be `activation_unavailable` or `activation_unauthenticated`.

- df18325: Add the Phase 1 replication B-node surface for the TC-858 read-through flag: `sqliteReplicaStorage` (Node entry only), the per-prefix `ReplicationAuthority`, `planDelegation`/`replicationAuthority`, `replicationSignInEntries()`, and sign-in augmentation.
  - `replication` config (enabled, prefixes, storage, allowSecrets) is validated at construction: storage is required, prefixes must be non-empty and non-overlapping, and `vault/` prefixes require `allowSecrets`.
  - Sign-in requests gain one `{tinycloud.kv, space, prefix, [get, sync]}` entry per configured prefix already covered by an unrestricted `get` under the same `isCapabilitySubset` semantics the signed-recap check uses — an exact-path `get(notes)` never authorizes a `notes/private` entry, and secrets-primary coverage is measured against the effective secrets request, not `defaultActions`; `replicationSignInEntries()` returns the same augmentation the SIWE recap carries for the restore check (Phase 2).
  - `sqliteReplicaStorage({ dir, guard })` provides durable SQLite replicas partitioned by canonical identity (host + space + principal), ALWAYS-durable `pending.json` pending state (never an in-memory fallback; a guard serializes cross-process read-modify-write), a per-replica `syncedThroughEpoch` fence persisted only on successful sync, and purge across the deduplicated device union. Purge bumps the replica's generation before removing it, so a handle opened beforehand fails `RESET_REQUIRED` on its next call. Grant reuse reports `unconstrained` computed from the signed `att`; caveated grants are never installed. `@tinycloud/replica`, `/sqlite` and the WASM binding load lazily and require Node ≥ 22.13.
  - `TinyCloudNode.planDelegation()` is the pure parent selection `delegateTo` runs; `replicationAuthority()` backs the controller's session/runtime grant strategies, refusing `CAVEATED_AUTHORITY` for caveat-only coverage.
  - The node now owns one lazy replication runtime across session replacement and restore. It binds to canonical host + primary space + principal, shares durable pending state for the same identity, attaches read-through only to primary-space KV services, and unbinds those services when the graph retires. Runtime controls expose status, sync, purge and pending cleanup; the runtime stays in the Node entry and does not enter the web bundle.
  - Pending partition updates re-resolve the canonical path on every write and fail closed with `STORAGE_ERROR` after a symlink target changes. Existing unconstrained grants are reused only when parent/expiry policy permits; an offline mint cannot replace a constrained grant.

  Consumers that instantiate `TinyCloudNode` with `replication.enabled: true` must now supply `replication.storage`.
  Replication-enabled `/core` consumers may register a browser-safe runtime and authority loader with `registerReplicationLoaders()`; `/core` itself still does not import the controller. The runtime and authority loaders are available at public ESM/CJS subpaths. Every primary-space KV view, including views created during a rebind and restored `SpaceService` factories, waits for the current binding before routing. Compact delegate restores verify the signed UCAN and derive the owner principal from its signed space resource locally; mismatched unsigned `spaceId` metadata disables replica use with `SESSION_SCOPE_MISMATCH` and does not trigger `/delegate`. Compact delegate sessions can serve only prefixes covered by their own signed grant, never a storage-device grant.
  - Purge stops timers and aborts syncs synchronously before its asynchronous drain; every bind/unbind preserves the full outstanding close chain so later storage opens cannot overtake an earlier close.

  The replication authority checks compact-session signature, CID, audience, and signed resource scope before local use. Delegate posture is network-only when its signed get+sync coverage does not include the configured prefix; installed grants cannot widen it.

### Patch Changes

- 6a7fa64: A SIWE-less session created by `tc auth import` now expires locally at the compact UCAN's signed `exp`; expired restores throw `AUTH_EXPIRED` before host lookup, including sessions imported by earlier releases. The new `signedCompactUcanExpiry` export reads that signed lifetime. CACAO-headed sessions remain refused only by the node.

  A request-bound compact import whose signed expiry passes during its locked store write now reports `DELEGATION_EXPIRED` and rolls back the grant and any provisional session. If a fresh delegate profile's provisional session expires during import, it is rolled back unless another writer has since changed the profile. Cross-user compact imports require transport expiry to match signed `exp`, and persist the signed expiry. An import that is already expired or expires before activation also reports `DELEGATION_EXPIRED` without storing a grant.

  The client clock is authoritative. `context` reports imported-session expiry, and the scoped paste login named by the hint is no longer blocked by an unknown expiry. Before probing a configured local node, session-using commands verify the stored session locally; this also covers older imported sessions. Login, logout, rotate, status, whoami, context, node, profile, `space host-request|switch`, `enable`, `auth request` without `--grant`, explicit private-key commands, and profiles without a stored session retain discovery behavior. Deferred discovery after owner refresh respects a context copied with another host.

- 4756923: Location registry and target `/info` failures, single-source location resolution failures, manifest fetches, node version checks, and CLI delegation-code fetches now carry typed HTTP status. A 401 or 403 from these producers is an authorization verdict: the CLI exits with `AUTH_REQUIRED` or `PERMISSION_DENIED` instead of `ERROR`, `withSessionRefresh` signs in again on 401, and account-registry sync stops rather than retrying a single-source location 401 or 403. Location resolutions with multiple independent failures remain unclassified.

  Hook timeouts are classified from HTTP status rather than response text: 408 and 504 report `TIMEOUT`, while hook HTTP error messages containing `timeout` retain the server's diagnostic text. Account-registry retry uses the message fallback only for genuinely untyped errors. The untyped session-error fallback ignores standalone single-quoted names, not apostrophes inside words, and strips quoted names in linear time (also fixing master's slow case with many escaped double quotes).

  An account-index initialization failure, whether a failed result or a thrown error, no longer blocks or retries account-registry sync; it is warned at most once per sync with only its HTTP status and error code, and the canonical registry writes and space sync continue.

- df18325: Bound the sign-in account-registry drain to four seconds and abort its SQL, KV, and hosting requests on expiry. Registry failures remain warning-only, so sign-in succeeds after the bounded drain.
- df18325: Exact-key grants cannot cover folders under sdk-core capability containment. Local LIST keeps the exact-only network fallback and nested-LIST pending-write protection.
- 47eb547: Replication prefixes are folders such as `notes/`, or `/` for the whole space (requires a node advertising `kv-sync-root`). Bare paths and `""` are rejected.

  For local-key and eligible owner OpenKey sign-ins with unrestricted whole-space KV get coverage, replication adds sync once to the existing whole-space KV entry. Narrower owner coverage and delegated/device grants retain per-prefix scope.

  Published `@tinycloud/replica` declarations, including `./browser` and `./worker`, are self-contained; consumers do not need `@tinycloud/sdk-services`.

  `kvSyncTransport(kv)` discovers the node host exposed by the KV service for whole-space feature checks. If the service does not expose a host, pass `{ host }`; root sync refuses early with a clear error rather than skipping the `kv-sync-root` check.

- df18325: Run account-registry SQL, KV, and hosting requests through a dedicated per-operation context so the sign-in deadline cannot abort unrelated requests or persist in cached space-scoped services. Await SQL and DuckDB error-body reads before disposing request cancellation listeners.
- df18325: Replica status reads existing SQLite state read-only without creating a replica, identity, device, or blob directories, and never recreates a database that does not exist or was purged. Existing databases use normal read-only WAL mode so committed revocation and reset state is visible; SQLite may create its own WAL or shared-memory sidecars. Missing databases remain untouched, and open/read failures report unavailable rather than healthy. Inspection explicitly finalizes prepared statements before closing both inspection and ordinary store handles. Status inspection is bounded and cancelled on controller close or purge; in-process grant revocation remains visible after the handle is generation-fenced.
- d825e49: A fresh owner's first private-key sign-in (`tc auth login --method local`, or `TinyCloudNode.signIn()` with a private key) no longer warns `account bootstrap failed: … 401 - Unauthorized Action: …:account/sql/account / tinycloud.sql/schema`, and it creates the account index, registry and bootstrap marker on the account space. Previously these were only repaired on the next sign-in. The default bootstrap session now signs each requested permission onto its own space, as sign-in already does, and an operation on another space that a bootstrap session covers is invoked against that space (TC-957).
- Updated dependencies [8b56ee8]
- Updated dependencies [26f86bd]
- Updated dependencies [ad4a11f]
- Updated dependencies [4756923]
- Updated dependencies [4f851e6]
- Updated dependencies [df18325]
- Updated dependencies [df18325]
- Updated dependencies [df18325]
- Updated dependencies [df18325]
- Updated dependencies [47eb547]
- Updated dependencies [df18325]
- Updated dependencies [df18325]
- Updated dependencies [df18325]
- Updated dependencies [df18325]
  - @tinycloud/replica@0.2.0
  - @tinycloud/sdk-services@3.2.0
  - @tinycloud/sdk-core@3.2.0

## 3.2.0-beta.9

### Patch Changes

- d825e49: A fresh owner's first private-key sign-in (`tc auth login --method local`, or `TinyCloudNode.signIn()` with a private key) no longer warns `account bootstrap failed: … 401 - Unauthorized Action: …:account/sql/account / tinycloud.sql/schema`, and it creates the account index, registry and bootstrap marker on the account space. Previously these were only repaired on the next sign-in. The default bootstrap session now signs each requested permission onto its own space, as sign-in already does, and an operation on another space that a bootstrap session covers is invoked against that space (TC-957).

## 3.2.0-beta.8

### Patch Changes

- 4756923: Location registry and target `/info` failures, single-source location resolution failures, manifest fetches, node version checks, and CLI delegation-code fetches now carry typed HTTP status. A 401 or 403 from these producers is an authorization verdict: the CLI exits with `AUTH_REQUIRED` or `PERMISSION_DENIED` instead of `ERROR`, `withSessionRefresh` signs in again on 401, and account-registry sync stops rather than retrying a single-source location 401 or 403. Location resolutions with multiple independent failures remain unclassified.

  Hook timeouts are classified from HTTP status rather than response text: 408 and 504 report `TIMEOUT`, while hook HTTP error messages containing `timeout` retain the server's diagnostic text. Account-registry retry uses the message fallback only for genuinely untyped errors. The untyped session-error fallback ignores standalone single-quoted names, not apostrophes inside words, and strips quoted names in linear time (also fixing master's slow case with many escaped double quotes).

  An account-index initialization failure, whether a failed result or a thrown error, no longer blocks or retries account-registry sync; it is warned at most once per sync with only its HTTP status and error code, and the canonical registry writes and space sync continue.

- Updated dependencies [4756923]
  - @tinycloud/sdk-core@3.2.0-beta.8
  - @tinycloud/sdk-services@3.2.0-beta.8

## 3.2.0-beta.7

### Minor Changes

- 26f86bd: TC-628: Storage status, one `storage.full` event, and no doomed writes on read paths.
  - Storage rejections read the node's JSON 402/413 body. `meta.usedBytes`/`meta.limitBytes` still describe the space, and `meta.account` carries `{ usedBytes, limitBytes, plan }` for the whole account when the node sends it. The old plain-text body still parses. SQL and DuckDB now report a storage 413 (the node's `storage_limit_reached` body or storage text) as `STORAGE_LIMIT_REACHED`, as KV already did; a 413 without it stays `*_RESPONSE_TOO_LARGE`.
  - `tc.on("storage.full", handler)` on `TinyCloudNode` and `TinyCloudWeb` fires once, on the first write any service has rejected for storage. The event carries the code, the space numbers, `account` and the rejected `spaceId`. It also goes through the service context's `emit` as `storage.full` (`TelemetryEvents.STORAGE_FULL`). Which owners are full is recorded per owner, so a full delegated space never hides that the signed-in account is full too. It fires again once `storage.status()` has reported room for every owner whose write was rejected, or after signing in or restoring a session whose primary space belongs to a different owner. Restoring the same owner with or without the optional address/SIWE metadata keeps the episode.
  - `tc.storage.status({ space? })` reads usage and plan from the node (`tinycloud.space/info`, TC-626) and returns `{ usedBytes, limitBytes, account, plan, state, manageUrl }`. `state` is `ok`, `nearly_full` (≥ 90%) or `full`, from the account totals when known, and `limitBytes: null` means unlimited. It needs `tinycloud.space/info` on that space, from the session recap or an installed runtime delegation. Default sessions do not request it yet. When the grant cannot be confirmed locally, it returns `PERMISSION_DENIED` and sends no request. A node without the usage read returns the new `STORAGE_STATUS_UNAVAILABLE` code.
  - While the signed-in account's storage is known full:
    - `spaces.list()` still lists, but does not register each listed space;
    - sign-in skips the bootstrap repair (`bootstrapStatus.reason: "storage-full"`);
    - sign-in skips the background account registry sync (index ensure, manifest records, space sync).

    These writes would only be refused again. A rejection on another owner's space does not stop them, and does not hide a later rejection on the account's own.

  - `SpaceServiceConfig` (and `SpaceServiceConfigSchema`) accepts `isStorageFull?: () => boolean`; when it returns true, `list()` skips `onSpaceRegistered`.
  - New exports:
    - functions and values: `parseStorageRejection`, `parseStorageStatus`, `storageUsageState`, `StorageFullMonitor` (per-owner: `isFullFor(spaceId)`, `clearFor(spaceId)`), `STORAGE_MANAGE_URL`, `STORAGE_NEARLY_FULL_RATIO`, and the error code `ErrorCodes.STORAGE_STATUS_UNAVAILABLE`;
    - types: `StorageStatus`, `StorageStatusOptions`, `StorageUsage`, `StorageUsageState`, `IStorageService`, `StorageFullEvent`, `StorageFullHandler`, `StorageAccountUsage` and `StorageRejectionDetails`.
  - Deprecated, still exported unchanged: `TinyCloudQuota`, `QuotaConfig`, `QuotaStatus` and `StorageQuotaInfo`. Use `storage.status()` and `on("storage.full")` instead.

### Patch Changes

- Updated dependencies [26f86bd]
  - @tinycloud/sdk-services@3.2.0-beta.7
  - @tinycloud/sdk-core@3.2.0-beta.7

## 3.2.0-beta.6

### Minor Changes

- 33efc8c: Export `siweRuntimeDelegation` to project an OpenKey signed-login (SIWE/ReCap CACAO) grant into a portable runtime delegation. A decrypt-only projection retains its owner space when the signed ReCap has no space entry.

## 3.2.0-beta.5

### Patch Changes

- 47eb547: Replication prefixes are folders such as `notes/`, or `/` for the whole space (requires a node advertising `kv-sync-root`). Bare paths and `""` are rejected.

  For local-key and eligible owner OpenKey sign-ins with unrestricted whole-space KV get coverage, replication adds sync once to the existing whole-space KV entry. Narrower owner coverage and delegated/device grants retain per-prefix scope.

  Published `@tinycloud/replica` declarations, including `./browser` and `./worker`, are self-contained; consumers do not need `@tinycloud/sdk-services`.

  `kvSyncTransport(kv)` discovers the node host exposed by the KV service for whole-space feature checks. If the service does not expose a host, pass `{ host }`; root sync refuses early with a clear error rather than skipping the `kv-sync-root` check.

- Updated dependencies [47eb547]
  - @tinycloud/replica@0.2.0-beta.2
  - @tinycloud/sdk-services@3.2.0-beta.5
  - @tinycloud/sdk-core@3.2.0-beta.5

## 3.2.0-beta.4

### Patch Changes

- Updated dependencies [8b56ee8]
  - @tinycloud/replica@0.1.1-beta.1

## 3.2.0-beta.3

### Minor Changes

- df18325: Add the Phase 1 replication B-node surface for the TC-858 read-through flag: `sqliteReplicaStorage` (Node entry only), the per-prefix `ReplicationAuthority`, `planDelegation`/`replicationAuthority`, `replicationSignInEntries()`, and sign-in augmentation.
  - `replication` config (enabled, prefixes, storage, allowSecrets) is validated at construction: storage is required, prefixes must be non-empty and non-overlapping, and `vault/` prefixes require `allowSecrets`.
  - Sign-in requests gain one `{tinycloud.kv, space, prefix, [get, sync]}` entry per configured prefix already covered by an unrestricted `get` under the same `isCapabilitySubset` semantics the signed-recap check uses — an exact-path `get(notes)` never authorizes a `notes/private` entry, and secrets-primary coverage is measured against the effective secrets request, not `defaultActions`; `replicationSignInEntries()` returns the same augmentation the SIWE recap carries for the restore check (Phase 2).
  - `sqliteReplicaStorage({ dir, guard })` provides durable SQLite replicas partitioned by canonical identity (host + space + principal), ALWAYS-durable `pending.json` pending state (never an in-memory fallback; a guard serializes cross-process read-modify-write), a per-replica `syncedThroughEpoch` fence persisted only on successful sync, and purge across the deduplicated device union. Purge bumps the replica's generation before removing it, so a handle opened beforehand fails `RESET_REQUIRED` on its next call. Grant reuse reports `unconstrained` computed from the signed `att`; caveated grants are never installed. `@tinycloud/replica`, `/sqlite` and the WASM binding load lazily and require Node ≥ 22.13.
  - `TinyCloudNode.planDelegation()` is the pure parent selection `delegateTo` runs; `replicationAuthority()` backs the controller's session/runtime grant strategies, refusing `CAVEATED_AUTHORITY` for caveat-only coverage.
  - The node now owns one lazy replication runtime across session replacement and restore. It binds to canonical host + primary space + principal, shares durable pending state for the same identity, attaches read-through only to primary-space KV services, and unbinds those services when the graph retires. Runtime controls expose status, sync, purge and pending cleanup; the runtime stays in the Node entry and does not enter the web bundle.
  - Pending partition updates re-resolve the canonical path on every write and fail closed with `STORAGE_ERROR` after a symlink target changes. Existing unconstrained grants are reused only when parent/expiry policy permits; an offline mint cannot replace a constrained grant.

  Consumers that instantiate `TinyCloudNode` with `replication.enabled: true` must now supply `replication.storage`.
  Replication-enabled `/core` consumers may register a browser-safe runtime and authority loader with `registerReplicationLoaders()`; `/core` itself still does not import the controller. The runtime and authority loaders are available at public ESM/CJS subpaths. Every primary-space KV view, including views created during a rebind and restored `SpaceService` factories, waits for the current binding before routing. Compact delegate restores verify the signed UCAN and derive the owner principal from its signed space resource locally; mismatched unsigned `spaceId` metadata disables replica use with `SESSION_SCOPE_MISMATCH` and does not trigger `/delegate`. Compact delegate sessions can serve only prefixes covered by their own signed grant, never a storage-device grant.
  - Purge stops timers and aborts syncs synchronously before its asynchronous drain; every bind/unbind preserves the full outstanding close chain so later storage opens cannot overtake an earlier close.

  The replication authority checks compact-session signature, CID, audience, and signed resource scope before local use. Delegate posture is network-only when its signed get+sync coverage does not include the configured prefix; installed grants cannot widen it.

### Patch Changes

- df18325: Bound the sign-in account-registry drain to four seconds and abort its SQL, KV, and hosting requests on expiry. Registry failures remain warning-only, so sign-in succeeds after the bounded drain.
- df18325: Keep published segment-aware replica selection unchanged while using sdk-core capability containment only for authority. Bare selectors now request get/sync grants for the exact path and slash descendants through the shared public `grantPathsForSelector` helper; root and trailing-slash selectors remain single-path grants. LIST local serving requires complete selection coverage, and nested LIST pending writes force network fallback or cursor restart.
- df18325: Run account-registry SQL, KV, and hosting requests through a dedicated per-operation context so the sign-in deadline cannot abort unrelated requests or persist in cached space-scoped services. Await SQL and DuckDB error-body reads before disposing request cancellation listeners.
- df18325: Replica status reads existing SQLite state read-only without creating a replica, identity, device, or blob directories, and never recreates a database that does not exist or was purged. Existing databases use normal read-only WAL mode so committed revocation and reset state is visible; SQLite may create its own WAL or shared-memory sidecars. Missing databases remain untouched, and open/read failures report unavailable rather than healthy. Inspection explicitly finalizes prepared statements before closing both inspection and ordinary store handles. Status inspection is bounded and cancelled on controller close or purge; in-process grant revocation remains visible after the handle is generation-fenced.
- Updated dependencies [df18325]
- Updated dependencies [df18325]
- Updated dependencies [df18325]
- Updated dependencies [df18325]
- Updated dependencies [df18325]
- Updated dependencies [df18325]
- Updated dependencies [df18325]
- Updated dependencies [df18325]
  - @tinycloud/sdk-services@3.2.0-beta.3
  - @tinycloud/sdk-core@3.2.0-beta.3
  - @tinycloud/replica@0.1.1-beta.0

## 3.2.0-beta.2

### Minor Changes

- 4f851e6: Create-only secret writes, app-derived secret scopes, typed vault write errors, and classified delegation activation failures.
  - **New:** `appSecretScope(appId)` derives the canonical secret scope for an app id (`com.listen.app` → `com-listen-app`), with `SECRET_SCOPE_RE`, `MAX_SECRET_SCOPE_LENGTH` (64) and `TC832_RESERVED_SCOPES` exported from every SDK package.
  - **New:** `secrets.put(name, value, { ifAbsent: true })` (type `SecretPutOptions`) writes only when the secret does not exist. An existing secret fails with vault error `ALREADY_EXISTS` (KV 412; `meta.status` and the typed KV error as `cause`) and is never overwritten. `DataVaultService.put` accepts `{ ifNoneMatch: "*" }` for network-encrypted vaults; a legacy (key-blob) vault refuses it with `STORAGE_ERROR` before any KV call. The Node and Web secrets wrappers forward the option unchanged.
  - **New:** a refused vault write keeps its authorization classification. A refused write is `AUTH_UNAUTHORIZED` only for HTTP 401 (sign-in needed). A 403 is `PERMISSION_DENIED`. Both keep `meta.status` and the typed KV error as `cause`, so `validatedCapabilityOf` still finds the missing capability. Other failures stay `STORAGE_ERROR`, now with `meta` and the KV error chained as the cause.
  - **Fix:** KV `get`/`head`/`delete` now honour their timeout and abort signal while reading a 404 body that never finishes, instead of hanging; `createSignedReadUrl` error bodies get the same fix.
  - **New:** node-sdk classifies delegation activation failures. `useRuntimeDelegation` reports an unreachable host as an error with `code: "ACTIVATION_TRANSPORT_FAILED"`. `RuntimeDelegationRejection` gains `activation_unavailable` (transport failure, 408, 429, 5xx) and `activation_unauthenticated` (401); every other activation failure stays `activation_rejected`.

  **Breaks:**
  - Code that matched `STORAGE_ERROR` for a vault or secrets write refused by authorization now receives `AUTH_UNAUTHORIZED` (401) or `PERMISSION_DENIED` (403, or no status).
  - `VaultError`/`VaultErrorInput` gain the `ALREADY_EXISTS`, `AUTH_UNAUTHORIZED` and `PERMISSION_DENIED` variants, so exhaustive `switch`es over the vault error code need the new cases.
  - Code that enumerates `RuntimeDelegationRejection` / `RUNTIME_DELEGATION_REJECTIONS` sees two new reasons; activation failures that were `activation_rejected` may now be `activation_unavailable` or `activation_unauthenticated`.

### Patch Changes

- Updated dependencies [4f851e6]
  - @tinycloud/sdk-services@3.2.0-beta.2
  - @tinycloud/sdk-core@3.2.0-beta.2

## 3.2.0-beta.1

### Patch Changes

- 6a7fa64: A SIWE-less session created by `tc auth import` now expires locally at the compact UCAN's signed `exp`; expired restores throw `AUTH_EXPIRED` before host lookup, including sessions imported by earlier releases. The new `signedCompactUcanExpiry` export reads that signed lifetime. CACAO-headed sessions remain refused only by the node.

  A request-bound compact import whose signed expiry passes during its locked store write now reports `DELEGATION_EXPIRED` and rolls back the grant and any provisional session. If a fresh delegate profile's provisional session expires during import, it is rolled back unless another writer has since changed the profile. Cross-user compact imports require transport expiry to match signed `exp`, and persist the signed expiry. An import that is already expired or expires before activation also reports `DELEGATION_EXPIRED` without storing a grant.

  The client clock is authoritative. `context` reports imported-session expiry, and the scoped paste login named by the hint is no longer blocked by an unknown expiry. Before probing a configured local node, session-using commands verify the stored session locally; this also covers older imported sessions. Login, logout, rotate, status, whoami, context, node, profile, `space host-request|switch`, `enable`, `auth request` without `--grant`, explicit private-key commands, and profiles without a stored session retain discovery behavior. Deferred discovery after owner refresh respects a context copied with another host.

## 3.2.0-beta.0

### Patch Changes

- Updated dependencies [ad4a11f]
  - @tinycloud/sdk-core@3.2.0-beta.0

## 3.1.0

### Minor Changes

- 02b6773: New canonical `agents` space; existing accounts run one bootstrap repair on next sign-in to add it. Bootstrap repair keeps existing account space records (renamed, archived, custom permissions) and only adds missing ones; new `AccountService.spaces.registerMissing()`. A sign-in that skips a non-account canonical space now repairs instead of re-seeding.
- 0652195: Session refresh and account-registry retry now decide from the typed HTTP status instead of the error text.
  - **Typed classification.** The new `authorizationVerdictOf(error)` reads a 4xx/5xx `status`, `statusCode` or `meta.status`, or the `AUTH_UNAUTHORIZED` code. It follows the `cause` chain from the outside in and skips success statuses. The outermost error status decides.
  - **Session refresh.** `withSessionRefresh` signs in again only after a 401. A 403 never triggers a refresh, whatever its body says. To keep the typed status, throw the `ServiceError` or an `Error` with it as `cause`.
  - **Untyped errors.** Message matching is now only a fallback. It drops double-quoted strings first (escape-aware), then takes the first 400-599 status in one of the SDK's diagnostic positions (`: 403` followed by whitespace or the end, `HTTP 401`, `returned 401`, `rejected (401)`, or a trailing `(403)`), and refreshes only if that status is 401. With no status, session wording on the original message decides. Numbers inside paths, ids, ports, byte counts or quoted keys no longer count.
  - **KV messages.** KV 401/403 errors now read `<operation>: <status> - <server text>`. They keep the server text, and `meta` is unchanged. Keys in KV error messages are written with `JSON.stringify`, so a key containing quotes stays well-formed.
  - **Hooks errors.** `HooksService` HTTP failures now carry `meta.status` (and `statusText`).
  - **Account-registry sync.** The wrappers keep the service error or host result as `cause`. These wrappers are `applications.register`, `spaces.syncAccessible`, owned-space activation, owned-space hosting and post-create re-activation. A 401 or 403 therefore stops after one request, even when the body is `Forbidden` or empty, and every wrapper message carries the status.
  - **Owner delegation import.** A failed activation during owner delegation import now keeps the activation result as `cause`.
  - **New method.** `NodeUserAuthorization.hostOwnedSpaceResult()` returns the full `SpaceHostResult`. `hostOwnedSpace()` still returns `boolean`.

- b7fd979: `activateValidatedRuntimeDelegation` takes a new `authorize` option. It sees the capabilities read from the signed delegation before anything is activated or installed, and returning `false` refuses the delegation.
- a074fa5: TC-619: When the owner's storage is full, reads keep working and writes fail with one typed error.
  - `db.migrations.apply()` reads the applied-migration list first. A database that is already up to date is opened with that one read and is never written, so an app that ensures its schema on open still loads on a full space or with a read-only session. The metadata table is created only when it is missing and a migration is pending. Before this, every call wrote a batch first, and a full space failed with `SQL batch failed: 402 - Storage quota exceeded…`.
  - KV, SQL and DuckDB report a write rejected for storage with the same codes: `STORAGE_QUOTA_EXCEEDED` (HTTP 402, storage is full) or `STORAGE_LIMIT_REACHED` (HTTP 413, the write is larger than what is left). The message explains that nothing was saved, that reading still works, and what to do. `meta` carries `status`, `usedBytes` and `limitBytes`. A 413 without the node's storage text, such as a proxy's request-size limit, stays `KV_WRITE_FAILED`. Behaviour change: SQL and DuckDB previously reported a 402 as `NETWORK_ERROR`.
  - Vault and secrets writes keep the storage code, message and byte counts. Behaviour change: they previously wrapped them in `STORAGE_ERROR`.
  - New exports `isStorageFullError(error)`, `STORAGE_FULL_MESSAGE` and `STORAGE_WRITE_TOO_LARGE_MESSAGE` let an app detect "storage full" in one place and switch to a read-only view.
  - `account.spaces.list({ preferIndex: true })` still lists accessible spaces when the account space is full. An explicit `account.spaces.syncAccessible()` still reports the failure.
  - node-sdk's sign-in registry sync stops after the first storage-full rejection instead of retrying it three times.

- 045c2d3: Preserve typed HTTP status and bounded server response text in node-info, encryption-network, and V3 delivery failures using the shared sdk-core helper. Bootstrap, owned-space hosting, and runtime/delegation activation failures retain rejected host results through error causes and status-bearing messages. `hostOwnedSpace()` reports rejected host delegations without collapsing their status to a boolean.
- 698654e: TC-736: KV change feed client for `tinycloud.kv/sync` (tinycloud-node TC-732).
  - `kv.changes({ prefix, cursor?, limit?, retentionGrant?, signal?, timeout? })` reads one page of the ordered, delete-aware feed for a prefix and returns `{ changes, more, cursor, source, authority }`. Each change is a key's latest state (`{ key, deleted: false, etag, metadata }` or `{ key, deleted: true }`); read content with `get`/`batchGet` and check it against the ETag. A page never splits one invocation, so it can hold more than `limit` changes, and it can be empty with `more: true`. The cursor is opaque. The node must advertise `kv-sync-v1` in `/info`.
  - `prefix` and the returned keys are full paths in the space; the service's configured prefix is not applied. On a prefixed `KVService` such as `DelegatedAccess.kv`, strip that prefix before calling `get(change.key)`, or use `kv.withPrefix(path).changes()`, which follows everything under `path/` and returns keys relative to it. An empty prefix, on either form, is refused with `INVALID_INPUT`.
  - Errors: HTTP 410 is `KV_SYNC_RESET_REQUIRED` with `meta.reason` (`cursor-invalid` or `position-unknown`): discard sync state and restart without a cursor. A 401 naming `delegation-revoked` or `delegation-ancestor-revoked` is `AUTH_DELEGATION_REVOKED` or `AUTH_DELEGATION_ANCESTOR_REVOKED`. A refused retention grant (403) is `KV_RETENTION_GRANT_REFUSED` with `meta.reason`. A 404 for an unhosted space is `KV_NOT_FOUND`. The timeout and abort signal stay in force while an error body is read.
  - `KVAction.SYNC`, `KVAction.RETAIN`, `KV.SYNC` and `KV.RETAIN` name the new abilities. The vendored capability registry is re-vendored from tinycloud-node `d7f511f`, which registers both.
  - `tinycloud.kv/sync` and `tinycloud.kv/retain` must be granted by name. `actionContains` (exported with the new `isExplicitOnlyAction`), `SharingService.preflightGenerate()`/`generate()` and node-sdk's runtime-grant check no longer let `*` or `tinycloud.kv/*` cover them, matching the node. No default session or manifest includes them. Behaviour changes: a session holding only `tinycloud.kv/*` can no longer delegate either ability onward without a prompt, and a share asking for either under a `*` registry entry now goes to `onRootDelegationNeeded`. `SharingService` now uses `actionContains` for every action, so a `tinycloud.kv/*` registry entry covers the other KV actions there too, as it already did elsewhere.
  - Type-level break for outside implementers: `IKVService` (and the `IKVServiceLike` that `PrefixedKVService` wraps) gains a required `changes(options)` member, and `IPrefixedKVService` gains `changes(options?)`. A custom class or object that implements these interfaces must add the method to compile.
  - `secrets.listAll()` now fails with `INVALID_INPUT` when the node repeats a continuation cursor, instead of looping on a node that ignores list cursors.

- 1f44a61: Add `DelegateToOptions.onPrepared` so callers can durably record a grant before it goes live (TC-839). `delegateTo` calls `onPrepared(delegation)` with the exact `PortableDelegation` it then returns as `result.delegation` (CID included), after signing and before host activation, on both the session-key and runtime-grant paths. If the hook rejects, no `/delegate` activation request is sent and `delegateTo` rejects with that same error. Passing `onPrepared` together with `forceWalletSign: true` throws before anything is signed, because the wallet path activates as part of signing. `TinyCloudWeb.delegateTo` passes the option through unchanged. Calls without `onPrepared` behave as before.

### Patch Changes

- dca972f: An expired stored session now asks for a new sign-in instead of looking like a node failure (TC-607). When node-sdk refuses a persisted signed session as expired or no longer valid (`AUTH_EXPIRED`), the operations runtime returns a non-retryable `AUTH_REQUIRED` (the code TC-634 uses for a node's 401) instead of a retryable `NODE_ERROR`, and the CLI reports `AUTH_REQUIRED` (exit 3) with a sign-in hint for the profile's kind (scoped paste login for a delegate, `--method local` for a local owner key, `--method openkey` for an OpenKey owner). This covers `tc secrets get/list/put/delete`, `tc auth import` of a request-bound delegation, and every other command that restores a stored session; the refusal happens before any node request. Share commands keep their share-publishing sign-in guidance. Operations and MCP consumers that switch on error codes see `AUTH_REQUIRED` where they previously saw `NODE_ERROR` for this case. Any service result coded `AUTH_REQUIRED` or `PERMISSION_DENIED` without an HTTP status now exits 3 or 5 instead of 1 in commands using `cliErrorFromService` (account, delegation, duckdb, kv, secrets list/put/delete, space, sql, vars and vault); for example, `tc secrets list` without a grant returns the NodeSecretsService's status-less `PERMISSION_DENIED` with exit 5. `tc secrets get` and `tc auth import` also supply the profile kind's sign-in hint for `AUTH_REQUIRED`. A delegate session bootstrapped by `tc auth import` carries no signed expiry and is still refused by the node instead.

  Interactive secret escalation and `tc auth request --grant` now send OpenKey `/delegate` a request it signs, and the approved grant now authorizes `secrets get` (TC-609). Each request adds `tinycloud.capabilities/read` on its space root, keeps raw decrypt in the `encryption` pseudo-space with an EIP-55 owner, and anchors a decrypt-only request in the secrets space (`--space` when given) or, for `auth request --grant`, the profile's primary space. The signed proof is verified before anything is activated or stored; the added `capabilities/read` counts as requested, and any other authority beyond the request is refused.

  `activateValidatedRuntimeDelegation` now accepts wallet-signed CACAO session grants (OpenKey `/delegate`, `grantRuntimePermissions`) as well as compact UCANs. Such a grant must carry `siweProof` (its SIWE and signature, now set by `grantRuntimePermissions` and by the CLI when it stores an OpenKey grant); it is verified with the new `TinyCloudNode.verifySessionGrant` against the live session key, must be signed by the session's owner for one owner space and owner networks, and installs exactly the verified ReCap. The CLI stores each such grant (`tc auth request --grant`, secret-read approvals) with its `siweProof` and an `authorityRequest` binding to exactly its signed capabilities as validated activation reads them (`cli-grant:<cid>`, new `bindCliGrant` in `@tinycloud/operations/delegation-binding`), so the request-binding replay rule installs it in the CLI, `secrets get` and MCP; a signed-login record with a proof but no valid binding installs nothing. Grants stored without a proof by earlier releases are not used by operations. `replayStoredDelegation` now returns `{ status: "installed" | "skipped" | "not-replayed" }` with a fixed skip `reason` instead of the installed delegation or `undefined`. Refusals throw `RuntimeDelegationRejectedError` with a stable `reason` (`RUNTIME_DELEGATION_REJECTIONS`). Operation results gain an optional `warnings` array: every unexpired stored grant the runtime skips is listed as `{ code: "STORED_GRANT_SKIPPED", reason, grantCid? }` with a fixed reason code (including `unbound` and `outside_request` for the request-binding rule) and never error text, node responses or stored URLs (expired grants are still dropped silently); `grantCid` appears only when it is the CID recomputed from the stored authorization bytes. The CLI prints them inside its JSON error, beside TC-634's `meta` (also when an `-o` write or browser approval fails), as one JSON line on stderr after a successful command's output, or as one human-readable line. `--json` now selects JSON errors and warnings, and suppresses progress spinners, the banner and the missing-profile notice, even when stdout is a terminal; it is read from the parsed options, so a `--json` operand after `--` does not count. `secrets get` reports missing authority as `PERMISSION_DENIED` with exit 5 instead of exit 1.

- dca972f: A local-key grant of only raw decrypt on the owner's encryption network can be stored and used again (TC-609). `tc auth request --grant` and a secret read's escalation activated such a grant, then refused to store it, because verifying it reused the persisted-session check that a session's ReCap authorizes its primary space, and a raw network names no space. The new WASM export `validateSessionGrant` (optional `IWasmBindings.validateSessionGrant`, implemented by `NodeWasmBindings`) runs the same signature, signer, audience, lifetime, ReCap and CID checks, and waives the space check only for a grant whose ReCap holds nothing but raw encryption-network resources; a grant with no ReCap authority is refused. `TinyCloudNode.verifySessionGrant` uses it, falling back to `validatePersistedSession` (which refuses decrypt-only grants) for bindings without it. Restoring a session still uses `validatePersistedSession` and its space check.
- 2c703fc: SDK Core carries an explicit target-space and command-scoped authority CID when signing CLI revocations. The node SDK preserves raw CID ReCap resources and maps root raw-CID activation failures to the CLI's CID-bound owner-space fallback; the no-options `revokeDelegation(cid)` API retains its existing behavior.
- Updated dependencies [02b6773]
- Updated dependencies [ee4fd2d]
- Updated dependencies [37123c3]
- Updated dependencies [0652195]
- Updated dependencies [6484eba]
- Updated dependencies [dca972f]
- Updated dependencies [a074fa5]
- Updated dependencies [045c2d3]
- Updated dependencies [045c2d3]
- Updated dependencies [698654e]
- Updated dependencies [4df61ed]
- Updated dependencies [2c703fc]
- Updated dependencies [d11a8b6]
  - @tinycloud/sdk-core@3.1.0
  - @tinycloud/sdk-services@3.1.0
  - @tinycloud/node-sdk-wasm@1.7.7

## 3.1.0-beta.15

### Minor Changes

- 1f44a61: Add `DelegateToOptions.onPrepared` so callers can durably record a grant before it goes live (TC-839). `delegateTo` calls `onPrepared(delegation)` with the exact `PortableDelegation` it then returns as `result.delegation` (CID included), after signing and before host activation, on both the session-key and runtime-grant paths. If the hook rejects, no `/delegate` activation request is sent and `delegateTo` rejects with that same error. Passing `onPrepared` together with `forceWalletSign: true` throws before anything is signed, because the wallet path activates as part of signing. `TinyCloudWeb.delegateTo` passes the option through unchanged. Calls without `onPrepared` behave as before.

## 3.1.0-beta.14

### Patch Changes

- Updated dependencies [4df61ed]
  - @tinycloud/sdk-services@3.1.0-beta.14
  - @tinycloud/sdk-core@3.1.0-beta.14

## 3.1.0-beta.13

### Patch Changes

- Updated dependencies [d11a8b6]
  - @tinycloud/sdk-services@3.1.0-beta.13
  - @tinycloud/sdk-core@3.1.0-beta.13

## 3.1.0-beta.12

### Patch Changes

- 2c703fc: SDK Core carries an explicit target-space and command-scoped authority CID when signing CLI revocations. The node SDK preserves raw CID ReCap resources and maps root raw-CID activation failures to the CLI's CID-bound owner-space fallback; the no-options `revokeDelegation(cid)` API retains its existing behavior.
- Updated dependencies [2c703fc]
  - @tinycloud/sdk-core@3.1.0-beta.12

## 3.1.0-beta.11

### Minor Changes

- 02b6773: New canonical `agents` space; existing accounts run one bootstrap repair on next sign-in to add it. Bootstrap repair keeps existing account space records (renamed, archived, custom permissions) and only adds missing ones; new `AccountService.spaces.registerMissing()`. A sign-in that skips a non-account canonical space now repairs instead of re-seeding.

### Patch Changes

- Updated dependencies [02b6773]
  - @tinycloud/sdk-core@3.1.0-beta.11
  - @tinycloud/sdk-services@3.1.0-beta.11

## 3.1.0-beta.10

### Patch Changes

- Updated dependencies [37123c3]
  - @tinycloud/sdk-services@3.1.0-beta.10
  - @tinycloud/sdk-core@3.1.0-beta.10

## 3.1.0-beta.9

### Minor Changes

- 698654e: TC-736: KV change feed client for `tinycloud.kv/sync` (tinycloud-node TC-732).
  - `kv.changes({ prefix, cursor?, limit?, retentionGrant?, signal?, timeout? })` reads one page of the ordered, delete-aware feed for a prefix and returns `{ changes, more, cursor, source, authority }`. Each change is a key's latest state (`{ key, deleted: false, etag, metadata }` or `{ key, deleted: true }`); read content with `get`/`batchGet` and check it against the ETag. A page never splits one invocation, so it can hold more than `limit` changes, and it can be empty with `more: true`. The cursor is opaque. The node must advertise `kv-sync-v1` in `/info`.
  - `prefix` and the returned keys are full paths in the space; the service's configured prefix is not applied. On a prefixed `KVService` such as `DelegatedAccess.kv`, strip that prefix before calling `get(change.key)`, or use `kv.withPrefix(path).changes()`, which follows everything under `path/` and returns keys relative to it. An empty prefix, on either form, is refused with `INVALID_INPUT`.
  - Errors: HTTP 410 is `KV_SYNC_RESET_REQUIRED` with `meta.reason` (`cursor-invalid` or `position-unknown`): discard sync state and restart without a cursor. A 401 naming `delegation-revoked` or `delegation-ancestor-revoked` is `AUTH_DELEGATION_REVOKED` or `AUTH_DELEGATION_ANCESTOR_REVOKED`. A refused retention grant (403) is `KV_RETENTION_GRANT_REFUSED` with `meta.reason`. A 404 for an unhosted space is `KV_NOT_FOUND`. The timeout and abort signal stay in force while an error body is read.
  - `KVAction.SYNC`, `KVAction.RETAIN`, `KV.SYNC` and `KV.RETAIN` name the new abilities. The vendored capability registry is re-vendored from tinycloud-node `d7f511f`, which registers both.
  - `tinycloud.kv/sync` and `tinycloud.kv/retain` must be granted by name. `actionContains` (exported with the new `isExplicitOnlyAction`), `SharingService.preflightGenerate()`/`generate()` and node-sdk's runtime-grant check no longer let `*` or `tinycloud.kv/*` cover them, matching the node. No default session or manifest includes them. Behaviour changes: a session holding only `tinycloud.kv/*` can no longer delegate either ability onward without a prompt, and a share asking for either under a `*` registry entry now goes to `onRootDelegationNeeded`. `SharingService` now uses `actionContains` for every action, so a `tinycloud.kv/*` registry entry covers the other KV actions there too, as it already did elsewhere.
  - Type-level break for outside implementers: `IKVService` (and the `IKVServiceLike` that `PrefixedKVService` wraps) gains a required `changes(options)` member, and `IPrefixedKVService` gains `changes(options?)`. A custom class or object that implements these interfaces must add the method to compile.
  - `secrets.listAll()` now fails with `INVALID_INPUT` when the node repeats a continuation cursor, instead of looping on a node that ignores list cursors.

### Patch Changes

- Updated dependencies [698654e]
  - @tinycloud/sdk-services@3.1.0-beta.9
  - @tinycloud/sdk-core@3.1.0-beta.9

## 3.1.0-beta.8

### Patch Changes

- dca972f: An expired stored session now asks for a new sign-in instead of looking like a node failure (TC-607). When node-sdk refuses a persisted signed session as expired or no longer valid (`AUTH_EXPIRED`), the operations runtime returns a non-retryable `AUTH_REQUIRED` (the code TC-634 uses for a node's 401) instead of a retryable `NODE_ERROR`, and the CLI reports `AUTH_REQUIRED` (exit 3) with a sign-in hint for the profile's kind (scoped paste login for a delegate, `--method local` for a local owner key, `--method openkey` for an OpenKey owner). This covers `tc secrets get/list/put/delete`, `tc auth import` of a request-bound delegation, and every other command that restores a stored session; the refusal happens before any node request. Share commands keep their share-publishing sign-in guidance. Operations and MCP consumers that switch on error codes see `AUTH_REQUIRED` where they previously saw `NODE_ERROR` for this case. Any service result coded `AUTH_REQUIRED` or `PERMISSION_DENIED` without an HTTP status now exits 3 or 5 instead of 1 in commands using `cliErrorFromService` (account, delegation, duckdb, kv, secrets list/put/delete, space, sql, vars and vault); for example, `tc secrets list` without a grant returns the NodeSecretsService's status-less `PERMISSION_DENIED` with exit 5. `tc secrets get` and `tc auth import` also supply the profile kind's sign-in hint for `AUTH_REQUIRED`. A delegate session bootstrapped by `tc auth import` carries no signed expiry and is still refused by the node instead.

  Interactive secret escalation and `tc auth request --grant` now send OpenKey `/delegate` a request it signs, and the approved grant now authorizes `secrets get` (TC-609). Each request adds `tinycloud.capabilities/read` on its space root, keeps raw decrypt in the `encryption` pseudo-space with an EIP-55 owner, and anchors a decrypt-only request in the secrets space (`--space` when given) or, for `auth request --grant`, the profile's primary space. The signed proof is verified before anything is activated or stored; the added `capabilities/read` counts as requested, and any other authority beyond the request is refused.

  `activateValidatedRuntimeDelegation` now accepts wallet-signed CACAO session grants (OpenKey `/delegate`, `grantRuntimePermissions`) as well as compact UCANs. Such a grant must carry `siweProof` (its SIWE and signature, now set by `grantRuntimePermissions` and by the CLI when it stores an OpenKey grant); it is verified with the new `TinyCloudNode.verifySessionGrant` against the live session key, must be signed by the session's owner for one owner space and owner networks, and installs exactly the verified ReCap. The CLI stores each such grant (`tc auth request --grant`, secret-read approvals) with its `siweProof` and an `authorityRequest` binding to exactly its signed capabilities as validated activation reads them (`cli-grant:<cid>`, new `bindCliGrant` in `@tinycloud/operations/delegation-binding`), so the request-binding replay rule installs it in the CLI, `secrets get` and MCP; a signed-login record with a proof but no valid binding installs nothing. Grants stored without a proof by earlier releases are not used by operations. `replayStoredDelegation` now returns `{ status: "installed" | "skipped" | "not-replayed" }` with a fixed skip `reason` instead of the installed delegation or `undefined`. Refusals throw `RuntimeDelegationRejectedError` with a stable `reason` (`RUNTIME_DELEGATION_REJECTIONS`). Operation results gain an optional `warnings` array: every unexpired stored grant the runtime skips is listed as `{ code: "STORED_GRANT_SKIPPED", reason, grantCid? }` with a fixed reason code (including `unbound` and `outside_request` for the request-binding rule) and never error text, node responses or stored URLs (expired grants are still dropped silently); `grantCid` appears only when it is the CID recomputed from the stored authorization bytes. The CLI prints them inside its JSON error, beside TC-634's `meta` (also when an `-o` write or browser approval fails), as one JSON line on stderr after a successful command's output, or as one human-readable line. `--json` now selects JSON errors and warnings, and suppresses progress spinners, the banner and the missing-profile notice, even when stdout is a terminal; it is read from the parsed options, so a `--json` operand after `--` does not count. `secrets get` reports missing authority as `PERMISSION_DENIED` with exit 5 instead of exit 1.

- dca972f: A local-key grant of only raw decrypt on the owner's encryption network can be stored and used again (TC-609). `tc auth request --grant` and a secret read's escalation activated such a grant, then refused to store it, because verifying it reused the persisted-session check that a session's ReCap authorizes its primary space, and a raw network names no space. The new WASM export `validateSessionGrant` (optional `IWasmBindings.validateSessionGrant`, implemented by `NodeWasmBindings`) runs the same signature, signer, audience, lifetime, ReCap and CID checks, and waives the space check only for a grant whose ReCap holds nothing but raw encryption-network resources; a grant with no ReCap authority is refused. `TinyCloudNode.verifySessionGrant` uses it, falling back to `validatePersistedSession` (which refuses decrypt-only grants) for bindings without it. Restoring a session still uses `validatePersistedSession` and its space check.
- Updated dependencies [dca972f]
  - @tinycloud/node-sdk-wasm@1.7.7-beta.0
  - @tinycloud/sdk-core@3.1.0-beta.8

## 3.1.0-beta.7

### Patch Changes

- Updated dependencies [ee4fd2d]
  - @tinycloud/sdk-services@3.1.0-beta.7
  - @tinycloud/sdk-core@3.1.0-beta.7

## 3.1.0-beta.6

### Minor Changes

- 045c2d3: Preserve typed HTTP status and bounded server response text in node-info, encryption-network, and V3 delivery failures using the shared sdk-core helper. Bootstrap, owned-space hosting, and runtime/delegation activation failures retain rejected host results through error causes and status-bearing messages. `hostOwnedSpace()` reports rejected host delegations without collapsing their status to a boolean.

### Patch Changes

- Updated dependencies [045c2d3]
- Updated dependencies [045c2d3]
  - @tinycloud/sdk-core@3.1.0-beta.6
  - @tinycloud/sdk-services@3.1.0-beta.6

## 3.1.0-beta.5

### Minor Changes

- b7fd979: `activateValidatedRuntimeDelegation` takes a new `authorize` option. It sees the capabilities read from the signed delegation before anything is activated or installed, and returning `false` refuses the delegation.

## 3.1.0-beta.4

### Patch Changes

- @tinycloud/sdk-core@3.1.0-beta.4

## 3.1.0-beta.3

### Patch Changes

- Updated dependencies [6484eba]
  - @tinycloud/sdk-core@3.1.0-beta.3

## 3.1.0-beta.2

### Minor Changes

- a074fa5: TC-619: When the owner's storage is full, reads keep working and writes fail with one typed error.
  - `db.migrations.apply()` reads the applied-migration list first. A database that is already up to date is opened with that one read and is never written, so an app that ensures its schema on open still loads on a full space or with a read-only session. The metadata table is created only when it is missing and a migration is pending. Before this, every call wrote a batch first, and a full space failed with `SQL batch failed: 402 - Storage quota exceeded…`.
  - KV, SQL and DuckDB report a write rejected for storage with the same codes: `STORAGE_QUOTA_EXCEEDED` (HTTP 402, storage is full) or `STORAGE_LIMIT_REACHED` (HTTP 413, the write is larger than what is left). The message explains that nothing was saved, that reading still works, and what to do. `meta` carries `status`, `usedBytes` and `limitBytes`. A 413 without the node's storage text, such as a proxy's request-size limit, stays `KV_WRITE_FAILED`. Behaviour change: SQL and DuckDB previously reported a 402 as `NETWORK_ERROR`.
  - Vault and secrets writes keep the storage code, message and byte counts. Behaviour change: they previously wrapped them in `STORAGE_ERROR`.
  - New exports `isStorageFullError(error)`, `STORAGE_FULL_MESSAGE` and `STORAGE_WRITE_TOO_LARGE_MESSAGE` let an app detect "storage full" in one place and switch to a read-only view.
  - `account.spaces.list({ preferIndex: true })` still lists accessible spaces when the account space is full. An explicit `account.spaces.syncAccessible()` still reports the failure.
  - node-sdk's sign-in registry sync stops after the first storage-full rejection instead of retrying it three times.

### Patch Changes

- Updated dependencies [a074fa5]
  - @tinycloud/sdk-services@3.1.0-beta.2
  - @tinycloud/sdk-core@3.1.0-beta.2

## 3.1.0-beta.1

### Minor Changes

- 0652195: Session refresh and account-registry retry now decide from the typed HTTP status instead of the error text.
  - **Typed classification.** The new `authorizationVerdictOf(error)` reads a 4xx/5xx `status`, `statusCode` or `meta.status`, or the `AUTH_UNAUTHORIZED` code. It follows the `cause` chain from the outside in and skips success statuses. The outermost error status decides.
  - **Session refresh.** `withSessionRefresh` signs in again only after a 401. A 403 never triggers a refresh, whatever its body says. To keep the typed status, throw the `ServiceError` or an `Error` with it as `cause`.
  - **Untyped errors.** Message matching is now only a fallback. It drops double-quoted strings first (escape-aware), then takes the first 400-599 status in one of the SDK's diagnostic positions (`: 403` followed by whitespace or the end, `HTTP 401`, `returned 401`, `rejected (401)`, or a trailing `(403)`), and refreshes only if that status is 401. With no status, session wording on the original message decides. Numbers inside paths, ids, ports, byte counts or quoted keys no longer count.
  - **KV messages.** KV 401/403 errors now read `<operation>: <status> - <server text>`. They keep the server text, and `meta` is unchanged. Keys in KV error messages are written with `JSON.stringify`, so a key containing quotes stays well-formed.
  - **Hooks errors.** `HooksService` HTTP failures now carry `meta.status` (and `statusText`).
  - **Account-registry sync.** The wrappers keep the service error or host result as `cause`. These wrappers are `applications.register`, `spaces.syncAccessible`, owned-space activation, owned-space hosting and post-create re-activation. A 401 or 403 therefore stops after one request, even when the body is `Forbidden` or empty, and every wrapper message carries the status.
  - **Owner delegation import.** A failed activation during owner delegation import now keeps the activation result as `cause`.
  - **New method.** `NodeUserAuthorization.hostOwnedSpaceResult()` returns the full `SpaceHostResult`. `hostOwnedSpace()` still returns `boolean`.

### Patch Changes

- Updated dependencies [0652195]
  - @tinycloud/sdk-services@3.1.0-beta.1
  - @tinycloud/sdk-core@3.1.0-beta.1

## 3.0.1-beta.0

### Patch Changes

- @tinycloud/sdk-core@3.0.1-beta.0

## 3.0.0

### Major Changes

- c690844: Complete the TC-498/TC-500 native-sharing beta cutover. The legacy
  broker-backed Share APIs, link/transport compatibility paths, and retired CLI
  Share flags are intentionally removed. Use owner-Node native bearer
  delegations or signed Policy/v3 addressed shares; this release does not retain
  a parallel legacy broker authority plane.
- b852650: Seal Policy/v3 recipient metadata as the canonical AES-256-GCM
  `version || nonce || ciphertext+tag` blob before constructing an addressed
  share link. Delivery authorization now binds that sealed blob and its
  fragment-only key, rather than accepting a plaintext `?tc2` envelope. Remove
  the public plaintext Policy/v3 inline URL codec; only sealed fragment links
  are accepted for addressed shares. Add the reusable app-neutral
  OpenCredentials invitation client and bind notification retries to the signed
  delivery JTI/nonce used by Node and OpenCredentials deduplication.

### Minor Changes

- 70e6c95: Durable, re-delegatable share access (TC-531) and email delivery for
  email-domain shares (TC-530).
  - **Durable sessions.** Policy admission asks the Node for a session as long
    as the share: `requestedExpiresAt`, which defaults to the policy's expiry
    and can be set to `null` for the legacy minute. On Nodes before 1.17.3,
    which reject the field with 422, it falls back to the 60-second session.
    The request asks for the earlier of the envelope's and the policy's expiry.
    Received sessions longer than 60 seconds are accepted:
    `ShareRecipientClient` bounds them by the share's expiry, and
    `parsePolicySessionUcan` by the 31-day root window.
  - **Re-delegation.** `ReceivedShare.delegate({ to, expiresAt? })`
    re-delegates a received share, decryption included, to another Ed25519
    `did:key`, for example an account session key. It imports the new link into
    the owner's Node and returns the whole chain. The delegate opens the share
    with `share.receive(url, { delegation })` and needs no credential.
    `ShareRecipientClient` verifies every link before use: issuer, the exact
    parent proof, a strictly narrower window, inherited facts with one less
    redelegation, and unchanged capabilities.
  - `signCompactPolicyDescendant` signs a policy descendant with a
    caller-owned, possibly non-extractable, key.
  - **Default to the maximum.** These now default to the longest their parent
    allows, instead of a minute or an hour:
    - policy descendants;
    - `createSubDelegation`;
    - sessions activated from a received delegation.
  - **Domain shares** may grant edit access and may be emailed, like exact-email
    shares. Addressed publishing now refuses unknown policy actions for every
    share kind.

### Patch Changes

- 46c83a7: Add `secrets.listAll()` to discover global and scoped secret names across the
  canonical vault keyset without decrypting secret values.
- 036ce34: Raise the default sign-in session lifetime (`EXPIRY.SESSION_MS`) from 7 days to 30 days. `TinyCloudNode`, `NodeUserAuthorization`, `TinyCloudWeb`, and the `delegateTo` default expiry inherit the new value when `sessionExpirationMs` / `expiry` is not set. Long-running backend services and agents now re-sign in less often; revocation remains the control for ending a session early, and delegations minted from a session stay bounded by the session's expiry. Share-link (`EXPIRY.SHARE_MS`, 7 days), app manifest, ephemeral, and signed-read-URL defaults are unchanged.
- 31043b5: Finish the TC-500 production receiver path: authorize exact-email notifications
  for Policy/v3 shares through a Node-signed, single-use delivery receipt, and let
  the receiver use an enabled degraded acquisition profile while continuing to
  reject disabled profiles.
- d8b122e: Bind restored-session share publication to the signed owner space, compare EIP-155 owner addresses without case sensitivity, classify authority failures, and constrain implicit share expiry to session lifetime.
- d8b122e: Preserve actionable sharing and KV authorization diagnostics while keeping CLI output safe and session expiry guidance prioritized.
- d8b122e: Restore backwards-compatible auth codes and preserve typed session and authorization diagnostics across SDK boundaries.
- d8b122e: Harden share publication expiry clamping and map restored-session and authorization failures to typed, safe errors.
- 48eca36: TC-540: restoring a persisted session whose signed ReCap carries caveats no longer fails with "Verified persisted session ReCap contains invalid caveats". The WASM verifier returns caveat objects as `Map`s and JSON `null` as `undefined`; node-sdk now converts exactly those back to JSON (string-keyed `Map`s to plain objects, `undefined` to `null`, recursively) where verifier output enters the SDK (persisted-session restore and the caveat-preserving ReCap parser). Any other non-JSON caveat value is still rejected.
- 877097d: TC-599: Scoped OpenKey login can grant an agent read access to named secrets, and the secrets commands are safe to run headless.
  - `auth login --manifest` keeps raw `tinycloud.encryption` network entries in the `encryption` pseudo-space (never in the manifest's space), so the Secret Manager `secrets: { NAME: true }` shape passes first-login validation; the decrypt network uses the EIP-55-checksummed recorded owner or `--owner` (`OWNER_DID_UNKNOWN` otherwise), never the session `did:key`.
  - Every scoped login (browser, paste, device) requests `tinycloud.capabilities/read` on the space root when the manifest lacks it. A signed decrypt nested inside the owner's space is not raw authority: it is reported in `declined`, omitted from saved permissions so a later valid raw renewal is not blocked, and accompanied by an old-OpenKey warning. Foreign-owner decrypt grants are refused; device login refuses encryption and secrets-space manifests up front.
  - Browser `auth request --grant` and secret-read permission escalation verify the owner's signed OpenKey proof against the profile session key, requested space, scope and expiry. Only signed effective permissions are activated and persisted; old nested decrypt, foreign-owner, broadened or missing proof is refused before storage, and activation failure leaves local grants unchanged.
  - `auth login --paste` accepts a final code line without a newline and fails with `PASTE_CODE_MISSING` (exit 3, naming the approval URL) when stdin ends without a code.
  - `secrets get -o FILE` validates the destination and its existing directory before fetching secret bytes, syncs a new 0600 inode, and atomically replaces the destination. A best-effort parent-directory sync follows replacement without turning a completed write into an error. Symlinks, non-regular destinations, and absent parents are refused without unsafe fallback; filesystem output failures identify the destination without leaking the temporary filename.
  - With no TTY on stdin or stderr, `secrets get|list|put|delete` on an OpenKey profile lacking the grant fails with `PERMISSION_DENIED` (exit 5) and a scoped paste-login hint. A missing or real signed expired session fails with `AUTH_REQUIRED` (exit 3) before the canonical get operation or an unscoped browser refresh. Redirecting stdout alone still permits owner approval through stderr and terminal stdin.
  - node-sdk: a decrypt refused with HTTP 401/403 is reported as missing decrypt authority on the invoked network, never on a response-supplied resource or action.
  - node-sdk keeps an owner's space-nested encryption ReCap distinct from a raw network grant when restoring sessions, checking runtime permissions, and deriving further delegations.

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
- Updated dependencies [a132b77]
- Updated dependencies [2e9db6e]
  - @tinycloud/sdk-services@3.0.0
  - @tinycloud/sdk-core@3.0.0

## 3.0.0-beta.20

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

## 3.0.0-beta.19

### Minor Changes

- 70e6c95: Durable, re-delegatable share access (TC-531) and email delivery for
  email-domain shares (TC-530).
  - **Durable sessions.** Policy admission asks the Node for a session as long
    as the share: `requestedExpiresAt`, which defaults to the policy's expiry
    and can be set to `null` for the legacy minute. On Nodes before 1.17.3,
    which reject the field with 422, it falls back to the 60-second session.
    The request asks for the earlier of the envelope's and the policy's expiry.
    Received sessions longer than 60 seconds are accepted:
    `ShareRecipientClient` bounds them by the share's expiry, and
    `parsePolicySessionUcan` by the 31-day root window.
  - **Re-delegation.** `ReceivedShare.delegate({ to, expiresAt? })`
    re-delegates a received share, decryption included, to another Ed25519
    `did:key`, for example an account session key. It imports the new link into
    the owner's Node and returns the whole chain. The delegate opens the share
    with `share.receive(url, { delegation })` and needs no credential.
    `ShareRecipientClient` verifies every link before use: issuer, the exact
    parent proof, a strictly narrower window, inherited facts with one less
    redelegation, and unchanged capabilities.
  - `signCompactPolicyDescendant` signs a policy descendant with a
    caller-owned, possibly non-extractable, key.
  - **Default to the maximum.** These now default to the longest their parent
    allows, instead of a minute or an hour:
    - policy descendants;
    - `createSubDelegation`;
    - sessions activated from a received delegation.
  - **Domain shares** may grant edit access and may be emailed, like exact-email
    shares. Addressed publishing now refuses unknown policy actions for every
    share kind.

### Patch Changes

- Updated dependencies [70e6c95]
  - @tinycloud/sdk-core@3.0.0-beta.19

## 3.0.0-beta.18

### Patch Changes

- Updated dependencies [a132b77]
  - @tinycloud/sdk-core@3.0.0-beta.18

## 3.0.0-beta.17

### Patch Changes

- @tinycloud/sdk-core@3.0.0-beta.17

## 3.0.0-beta.16

### Patch Changes

- 48eca36: TC-540: restoring a persisted session whose signed ReCap carries caveats no longer fails with "Verified persisted session ReCap contains invalid caveats". The WASM verifier returns caveat objects as `Map`s and JSON `null` as `undefined`; node-sdk now converts exactly those back to JSON (string-keyed `Map`s to plain objects, `undefined` to `null`, recursively) where verifier output enters the SDK (persisted-session restore and the caveat-preserving ReCap parser). Any other non-JSON caveat value is still rejected.

## 3.0.0-beta.15

### Patch Changes

- Updated dependencies [2e9db6e]
  - @tinycloud/sdk-core@3.0.0-beta.15

## 3.0.0-beta.14

### Patch Changes

- d8b122e: Bind restored-session share publication to the signed owner space, compare EIP-155 owner addresses without case sensitivity, classify authority failures, and constrain implicit share expiry to session lifetime.
- d8b122e: Preserve actionable sharing and KV authorization diagnostics while keeping CLI output safe and session expiry guidance prioritized.
- d8b122e: Restore backwards-compatible auth codes and preserve typed session and authorization diagnostics across SDK boundaries.
- d8b122e: Harden share publication expiry clamping and map restored-session and authorization failures to typed, safe errors.
- Updated dependencies [d8b122e]
- Updated dependencies [d8b122e]
- Updated dependencies [d8b122e]
- Updated dependencies [d8b122e]
  - @tinycloud/sdk-core@3.0.0-beta.14
  - @tinycloud/sdk-services@3.0.0-beta.14

## 3.0.0-beta.13

### Patch Changes

- 036ce34: Raise the default sign-in session lifetime (`EXPIRY.SESSION_MS`) from 7 days to 30 days. `TinyCloudNode`, `NodeUserAuthorization`, `TinyCloudWeb`, and the `delegateTo` default expiry inherit the new value when `sessionExpirationMs` / `expiry` is not set. Long-running backend services and agents now re-sign in less often; revocation remains the control for ending a session early, and delegations minted from a session stay bounded by the session's expiry. Share-link (`EXPIRY.SHARE_MS`, 7 days), app manifest, ephemeral, and signed-read-URL defaults are unchanged.
- Updated dependencies [036ce34]
  - @tinycloud/sdk-core@3.0.0-beta.13

## 3.0.0-beta.12

### Patch Changes

- Updated dependencies [cc27c3a]
  - @tinycloud/sdk-core@3.0.0-beta.12

## 3.0.0-beta.11

### Patch Changes

- Updated dependencies [12e5c4d]
  - @tinycloud/sdk-core@3.0.0-beta.11

## 3.0.0-beta.10

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
  - @tinycloud/sdk-core@3.0.0-beta.10
  - @tinycloud/sdk-services@3.0.0-beta.10

## 3.0.0-beta.9

### Major Changes

- c690844: Complete the TC-498/TC-500 native-sharing beta cutover. The legacy
  broker-backed Share APIs, link/transport compatibility paths, and retired CLI
  Share flags are intentionally removed. Use owner-Node native bearer
  delegations or signed Policy/v3 addressed shares; this release does not retain
  a parallel legacy broker authority plane.

### Patch Changes

- Updated dependencies [c690844]
  - @tinycloud/sdk-core@3.0.0-beta.9

## 3.0.0-beta.8

### Patch Changes

- 46c83a7: Add `secrets.listAll()` to discover global and scoped secret names across the
  canonical vault keyset without decrypting secret values.
- Updated dependencies [46c83a7]
  - @tinycloud/sdk-services@3.0.0-beta.8
  - @tinycloud/sdk-core@3.0.0-beta.8

## 3.0.0-beta.7

### Patch Changes

- Updated dependencies [657c1ff]
  - @tinycloud/sdk-core@3.0.0-beta.7

## 3.0.0-beta.6

### Patch Changes

- 31043b5: Finish the TC-500 production receiver path: authorize exact-email notifications
  for Policy/v3 shares through a Node-signed, single-use delivery receipt, and let
  the receiver use an enabled degraded acquisition profile while continuing to
  reject disabled profiles.
- Updated dependencies [31043b5]
  - @tinycloud/sdk-core@3.0.0-beta.6

## 3.0.0-beta.5

### Patch Changes

- @tinycloud/sdk-core@3.0.0-beta.5

## 3.0.0-beta.2

### Patch Changes

- Updated dependencies [b0069f7]
  - @tinycloud/sdk-core@3.0.0-beta.2

## 3.0.0-beta.1

### Patch Changes

- Updated dependencies [4b60562]
  - @tinycloud/sdk-core@3.0.0-beta.1

## 3.0.0-beta.0

### Patch Changes

- Updated dependencies [ce34dc1]
  - @tinycloud/sdk-core@3.0.0-beta.0

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

- 7805213: Publish the TC-405 v3 delegation envelope and SDK together under fresh beta
  versions so consumers cannot resolve the stale `share-envelope@0.2.0-beta.0`
  artifact that predates the v3 APIs. Derive installed runtime-delegation
  provenance from signed UCAN authority and accept the node's canonical padded
  Base64 decrypt-response fields.
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
  - @tinycloud/sdk-core@2.11.0
  - @tinycloud/sdk-services@2.11.0
  - @tinycloud/node-sdk-wasm@1.7.6

## 2.11.0-beta.12

### Patch Changes

- 7805213: Publish the TC-405 v3 delegation envelope and SDK together under fresh beta
  versions so consumers cannot resolve the stale `share-envelope@0.2.0-beta.0`
  artifact that predates the v3 APIs. Derive installed runtime-delegation
  provenance from signed UCAN authority and accept the node's canonical padded
  Base64 decrypt-response fields.
  - @tinycloud/sdk-core@2.11.0-beta.12

## 2.11.0-beta.11

### Minor Changes

- d894c57: TC-393: recover incomplete account bootstrap with a durable account-space
  completion marker, canonical account registry read/create-update/list, delegation,
  capabilities-read, marker, and SQL coverage, and an idempotent
  repair pass. One-shot CoordinationOS OpenKey sessions now explicitly disable
  client-side bootstrap.

### Patch Changes

- Updated dependencies [d894c57]
  - @tinycloud/sdk-core@2.11.0-beta.11
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
- Updated dependencies [a7e3668]
- Updated dependencies [e525137]
- Updated dependencies [ba9c983]
  - @tinycloud/sdk-core@2.11.0-beta.10
  - @tinycloud/sdk-services@2.11.0-beta.10

## 2.11.0-beta.9

### Patch Changes

- Updated dependencies [10363b6]
  - @tinycloud/sdk-core@2.11.0-beta.9

## 2.11.0-beta.8

### Patch Changes

- Updated dependencies [68faad4]
  - @tinycloud/sdk-core@2.11.0-beta.8
  - @tinycloud/sdk-services@2.11.0-beta.8
  - @tinycloud/node-sdk-wasm@1.7.6-beta.0

## 2.11.0-beta.7

### Patch Changes

- 44ecf56: Release the exact-head session invocation APIs and canonical recipient-DID policy support used by Share.
- Updated dependencies [44ecf56]
- Updated dependencies [9fd8752]
- Updated dependencies [4ce36a6]
  - @tinycloud/sdk-core@2.11.0-beta.7
  - @tinycloud/sdk-services@2.11.0-beta.7

## 2.11.0-beta.5

### Minor Changes

- f0842d8: TC-373: fix two blockers found in review of the batched account-bootstrap seed-spaces write.
  - `KVService.batchPut` now attaches structured metadata (`requestMayHaveDispatched`, and on the two unconfirmed-2xx response paths, `responseReceived` / `status` / `outcome: "batch-unconfirmed"`) to `NETWORK_ERROR`/`TIMEOUT` failures instead of leaving them unclassified. No new `ErrorCodes` member is added — the ambiguity is carried entirely in `meta` to avoid widening the exported `ErrorCode` union.
  - `AccountService.spaces.registerBatch`'s internal ambiguous-failure classifier is now a strict allow-list (previously a deny-list that defaulted to "retry", so deterministic failures like 400/409/422, `INVALID_INPUT`, and 501/505 triggered five pointless per-space reconcile puts). `registerBatch` now returns `RegisterBatchSuccess` (`{ spaces, recoveredFromBatchError? }`) instead of a bare array, so a batch write that recovers via per-space reconciliation is visible on the success payload, not only via `console.warn`.
  - `TinyCloudNode.bootstrapStatus` gains an optional `warnings?: BootstrapWarning[]` field: bootstrap that completes via a recovered ambiguous write is now programmatically distinguishable from a clean run (both were previously `{ skipped: false }`).

  Both changes are additive; nothing published is broken.

### Patch Changes

- Updated dependencies [f0842d8]
  - @tinycloud/sdk-core@2.11.0-beta.5
  - @tinycloud/sdk-services@2.11.0-beta.5

## 2.11.0-beta.4

### Patch Changes

- 746cb02: Stop implicitly probing `127.0.0.1` during TinyCloud host discovery. Loopback
  discovery now requires an explicit `localNodeUrl`, while configured and
  registry-discovered `*.local.tinycloud.link` nodes continue to work.
- Updated dependencies [746cb02]
  - @tinycloud/sdk-core@2.11.0-beta.4

## 2.11.0-beta.3

### Patch Changes

- Updated dependencies [55e76c5]
  - @tinycloud/sdk-core@2.11.0-beta.3

## 2.11.0-beta.1

### Patch Changes

- d1d675b: Allow owner delegations to sign exact permissions across TinyCloud services, including the owner encryption network's decrypt capability, while preserving the legacy single-resource API.
- Updated dependencies [d1d675b]
  - @tinycloud/sdk-core@2.11.0-beta.1

## 2.11.0-beta.0

### Patch Changes

- Updated dependencies [b5d2e10]
  - @tinycloud/sdk-core@2.11.0-beta.0

## 2.10.0

### Minor Changes

- 28cc430: Add batch KV reads and memoize TinyCloud node descriptor lookups to reduce SDK round trips.

### Patch Changes

- Updated dependencies [28cc430]
- Updated dependencies [48a5408]
  - @tinycloud/sdk-core@2.10.0
  - @tinycloud/sdk-services@2.10.0

## 2.10.0-beta.1

### Patch Changes

- Updated dependencies [48a5408]
  - @tinycloud/sdk-core@2.10.0-beta.1

## 2.10.0-beta.0

### Minor Changes

- 28cc430: Add batch KV reads and memoize TinyCloud node descriptor lookups to reduce SDK round trips.

### Patch Changes

- Updated dependencies [28cc430]
  - @tinycloud/sdk-core@2.10.0-beta.0
  - @tinycloud/sdk-services@2.10.0-beta.0

## 2.9.0

### Minor Changes

- 9afb09c: Add localhost-first node resolution with identity pinning. Before falling back to registry/hosted resolution, `resolveTinyCloudHosts` now probes for a locally-running TinyCloud node (loopback, then `*.local.tinycloud.link`) and uses it if it answers and passes DID identity verification (trust-on-first-use, pinned per consumer). New opt-out and config knobs: `autoDiscoverLocalNode` (default true), `localNodeUrl`, `localLinkName`, `expectedNodeDid`, surfaced on node-sdk, web-sdk, and the CLI. Explicit host configuration (`host`, `--host`/`TC_HOST`) continues to skip discovery entirely.

### Patch Changes

- Updated dependencies [9afb09c]
  - @tinycloud/sdk-core@2.9.0

## 2.8.0

### Patch Changes

- Updated dependencies [7ecd455]
- Updated dependencies [7ecd455]
  - @tinycloud/sdk-services@2.8.0
  - @tinycloud/sdk-core@2.8.0

## 2.8.0-beta.0

### Patch Changes

- Updated dependencies [7ecd455]
- Updated dependencies [7ecd455]
  - @tinycloud/sdk-services@2.8.0-beta.0
  - @tinycloud/sdk-core@2.8.0-beta.0

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
- cd8c11f: Add an explicit-space classified secret-read API that preserves safe KV,
  envelope, decrypt, and payload failure phases without changing legacy secret
  reads.
- 1606a6f: Expose exact, expiry-pruned effective capabilities from activated runtime grants.

### Patch Changes

- 367c17c: Normalize session verification-method DID URLs to principal DIDs at the WASM delegation boundary so session-key delegations accept persisted `did:key:...#key-id` identities.
- 1269a58: Add canonical delegated account-space, application, and generic non-secrets KV exploration operations. Publish the beta MCP package with four corresponding read-only tools and a documented exact request, owner grant, import, restart, and retry workflow. Allow a fresh delegate profile to bootstrap from its first request-bound delegation while preserving canonical import validation.
- f6048b7: Keep TinyCloudNode session-key accessors synchronized with the active key and make repeated sign-in rotate that key safely, so delegation flows do not reference the removed default key.
- f5b1c75: Repair I2 release artifacts: bundle ESM-only multiformats dependencies for Node CommonJS consumers, preserve safe delegation mismatch details, and publish the canonical CLI auth import route.
- b982b90: Declare Node 20 or newer as the supported runtime floor for the complete published SDK and Operations graph, including the CLI and Node WASM bindings.
- d6d5ef1: Restore persisted sessions with their original private Ed25519 signer. Verify the signed SIWE, ReCap, Cacao header/CID, address, chain, session DID, and expiry before installing authority; atomically replace the auth/core/service host context while retaining every live secondary signer. Retired service graphs abort outstanding work and cannot reuse old encryption authority. Browser restore now preserves spaces and policy expiry, and rejected restores leave persisted storage untouched.
- 8777823: Add a CID-bound `activateValidatedRuntimeDelegation` helper that validates and installs compact UCAN runtime delegations.
- 96b9e21: Add `TinyCloudNode#getVerifiedSessionCapabilities` for the authenticated session's signed ReCap authority.
- Updated dependencies [940ff1d]
- Updated dependencies [f7a1d4f]
- Updated dependencies [f5b1c75]
- Updated dependencies [4dee0a9]
- Updated dependencies [b982b90]
- Updated dependencies [160c16e]
- Updated dependencies [d6d5ef1]
- Updated dependencies [cd8c11f]
  - @tinycloud/node-sdk-wasm@1.7.5
  - @tinycloud/sdk-core@2.7.0
  - @tinycloud/sdk-services@2.7.0

## 2.7.0-beta.5

### Patch Changes

- 1269a58: Add canonical delegated account-space, application, and generic non-secrets KV exploration operations. Publish the beta MCP package with four corresponding read-only tools and a documented exact request, owner grant, import, restart, and retry workflow. Allow a fresh delegate profile to bootstrap from its first request-bound delegation while preserving canonical import validation.

## 2.7.0-beta.4

### Minor Changes

- cd8c11f: Add an explicit-space classified secret-read API that preserves safe KV,
  envelope, decrypt, and payload failure phases without changing legacy secret
  reads.
- 1606a6f: Expose exact, expiry-pruned effective capabilities from activated runtime grants.

### Patch Changes

- f5b1c75: Repair I2 release artifacts: bundle ESM-only multiformats dependencies for Node CommonJS consumers, preserve safe delegation mismatch details, and publish the canonical CLI auth import route.
- b982b90: Declare Node 20 or newer as the supported runtime floor for the complete published SDK and Operations graph, including the CLI and Node WASM bindings.
- d6d5ef1: Restore persisted sessions with their original private Ed25519 signer. Verify the signed SIWE, ReCap, Cacao header/CID, address, chain, session DID, and expiry before installing authority; atomically replace the auth/core/service host context while retaining every live secondary signer. Retired service graphs abort outstanding work and cannot reuse old encryption authority. Browser restore now preserves spaces and policy expiry, and rejected restores leave persisted storage untouched.
- 8777823: Add a CID-bound `activateValidatedRuntimeDelegation` helper that validates and installs compact UCAN runtime delegations.
- 96b9e21: Add `TinyCloudNode#getVerifiedSessionCapabilities` for the authenticated session's signed ReCap authority.
- Updated dependencies [940ff1d]
- Updated dependencies [f5b1c75]
- Updated dependencies [b982b90]
- Updated dependencies [160c16e]
- Updated dependencies [d6d5ef1]
- Updated dependencies [cd8c11f]
  - @tinycloud/node-sdk-wasm@1.7.5-beta.0
  - @tinycloud/sdk-core@2.7.0-beta.4
  - @tinycloud/sdk-services@2.7.0-beta.4

## 2.7.0-beta.3

### Minor Changes

- f7a1d4f: Add signed account-wide delegation history queries with lifecycle and revocation
  status, plus CID-bound delegation revocation receipts and the account-scoped
  delegation control capabilities used by SDK sessions.

### Patch Changes

- Updated dependencies [f7a1d4f]
  - @tinycloud/sdk-core@2.7.0-beta.3

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

### Patch Changes

- Updated dependencies [4dee0a9]
  - @tinycloud/sdk-core@2.7.0-beta.2

## 2.6.4-beta.1

### Patch Changes

- 367c17c: Normalize session verification-method DID URLs to principal DIDs at the WASM delegation boundary so session-key delegations accept persisted `did:key:...#key-id` identities.

## 2.6.4-beta.0

### Patch Changes

- f6048b7: Keep TinyCloudNode session-key accessors synchronized with the active key and make repeated sign-in rotate that key safely, so delegation flows do not reference the removed default key.

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
  - @tinycloud/sdk-core@2.6.3

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
  - @tinycloud/sdk-core@2.6.3-beta.0

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
  - @tinycloud/sdk-core@2.6.2

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
  - @tinycloud/sdk-core@2.6.2-beta.0

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

- Updated dependencies [bf31506]
  - @tinycloud/sdk-core@2.6.1

## 2.6.1-beta.1

### Patch Changes

- @tinycloud/sdk-core@2.6.1-beta.1

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
  - @tinycloud/sdk-core@2.6.1-beta.0

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
  - @tinycloud/sdk-core@2.6.0

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
  - @tinycloud/sdk-core@2.6.0-beta.3

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
  - @tinycloud/sdk-core@2.6.0-beta.2

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
  - @tinycloud/sdk-core@2.6.0-beta.1

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
  - @tinycloud/sdk-core@2.6.0-beta.0

## 2.5.1

### Patch Changes

- 3b23940: Fix bootstrap space manifests granting unusable root capabilities. The default, applications, and public space manifests declared kv/sql permissions with `path: "/"`, which the recap encoder joined into resources like `applications/sql//` (double slash). The node's byte-prefix resource matching can never extend such a resource, so every invocation riding a bootstrap session delegation was rejected with "Unauthorized Action" — this is what broke Listen's first conversations query after OpenKey auto-sign bootstrap. Root permissions now use `path: ""`, which encodes as `applications/sql` and correctly covers all paths under the service.
  - @tinycloud/sdk-core@2.5.1

## 2.5.1-beta.0

### Patch Changes

- 3b23940: Fix bootstrap space manifests granting unusable root capabilities. The default, applications, and public space manifests declared kv/sql permissions with `path: "/"`, which the recap encoder joined into resources like `applications/sql//` (double slash). The node's byte-prefix resource matching can never extend such a resource, so every invocation riding a bootstrap session delegation was rejected with "Unauthorized Action" — this is what broke Listen's first conversations query after OpenKey auto-sign bootstrap. Root permissions now use `path: ""`, which encodes as `applications/sql` and correctly covers all paths under the service.
  - @tinycloud/sdk-core@2.5.1-beta.0

## 2.5.0

### Minor Changes

- dda499e: TC-86: browser auto-sign bootstrap support. `TinyCloudWeb` config accepts `signStrategy` and forwards it to `TinyCloudNode`, sign requests carry a `purpose` tag (`sign-in` / `bootstrap-session` / `bootstrap-host` / `message`) so strategies can route bootstrap signatures to OpenKey's server-side signer, and account-bootstrap failures degrade to a skipped bootstrap surfaced via `bootstrapStatus` instead of failing `signIn()`.

### Patch Changes

- cbd5dcc: Fix root sharing delegations to infer the delegated service from action URNs instead of always minting KV resources. Long-lived SQL share links now sign `tinycloud.sql/*` capabilities under the SQL service path.
- Updated dependencies [dda499e]
  - @tinycloud/sdk-core@2.5.0

## 2.5.0-beta.1

### Minor Changes

- dda499e: TC-86: browser auto-sign bootstrap support. `TinyCloudWeb` config accepts `signStrategy` and forwards it to `TinyCloudNode`, sign requests carry a `purpose` tag (`sign-in` / `bootstrap-session` / `bootstrap-host` / `message`) so strategies can route bootstrap signatures to OpenKey's server-side signer, and account-bootstrap failures degrade to a skipped bootstrap surfaced via `bootstrapStatus` instead of failing `signIn()`.

### Patch Changes

- Updated dependencies [dda499e]
  - @tinycloud/sdk-core@2.5.0-beta.1

## 2.4.1-beta.0

### Patch Changes

- cbd5dcc: Fix root sharing delegations to infer the delegated service from action URNs instead of always minting KV resources. Long-lived SQL share links now sign `tinycloud.sql/*` capabilities under the SQL service path.

## 2.4.0

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
- 08e292d: Thread `invokeAny` into `DelegatedAccess` so delegated sessions can form multi-action SQL invocations. `DelegatedAccess` previously built its `ServiceContext` with only the single-action `invoke`, so any SQL operation needing more than one action in a single `/invoke` — e.g. the migration runner's `ensureMigrationsTable`, which bundles a `CREATE TABLE` schema action with the tracking-row `write` — threw `SQL operation requires multiple permissions ... but this SDK runtime does not support multi-resource invocations`. `DelegatedAccess` now accepts an optional `invokeAny`, and both `TinyCloudNode` construction sites pass `wasmBindings.invokeAny`, mirroring how the top-level node session already wires it.
- 7c5fe21: Automatically ensure owner-owned encryption networks exist during manifest-driven sign-in. When a requested `tinycloud.encryption/decrypt` permission targets the signed-in user's network ID, the SDK adds a separate scoped `tinycloud.encryption/network.create` sign-in grant and `signIn()` creates the network if the node reports it missing.
- 8e8f7e8: Fix runtime permission grants silently failing to match across EIP-155 address-case differences.

  `TinyCloudNode.operationCovers` compared a runtime grant's `spaceId` against the requested operation's `spaceId` byte-for-byte. Stored runtime delegations (e.g. from `tc auth request --grant`, replayed on every node create) keep the EIP-55 **checksummed** address, while a space URI built by the CLI is **lowercased** — so a valid granted capability never matched and the invocation fell back to the base session, surfacing as a spurious `401 AUTH_UNAUTHORIZED` ("active session missing capability") even though `tc auth caps` showed the cap.

  Ethereum addresses are case-insensitive; space comparison now lowercases ONLY the `eip155:<chain>:0x<addr>` address segment before comparing, leaving the case-sensitive space NAME byte-exact. This is the runtime-grant analogue of the CLI-layer `OPENKEY_SCOPE_MISMATCH` fix (`normalizeSpaceForCompare`).

- fa4a7c7: Add regression coverage for SQL migration batches that require both `tinycloud.sql/ddl` and `tinycloud.sql/write`, including the legacy-session runtime permission repair path used by TinyCloud Secrets.
- d4a0a69: Add a SQL migrations helper on database handles: `sql.db(name).migrations.apply({ namespace, migrations })`. The helper records applied migration ids in a TinyCloud-managed table, signs migration DDL/write/read actions through the SQL service, and returns whether migrations were applied or already current.

  The account registry index now uses the migrations helper for its schema setup, and SQL/DuckDB service errors sanitize non-JSON proxy HTML pages into concise retryable messages while preserving a bounded debug snippet in error metadata.

- a22a7f0: Rename the SDK-emitted SQL schema-change permission from `tinycloud.sql/ddl` to `tinycloud.sql/schema`, including manifest defaults and account-registry grants.

  TinyCloudWeb now treats a restored persisted session as stale when it does not cover the currently configured manifest permissions, then runs the normal manifest sign-in flow instead of letting apps request those manifest permissions separately after login.

- 42f1235: Add an opt-in TinyCloud debug logger controlled by `TinyCloud_debug`. The logger keeps a 1000-event in-memory ring buffer, writes structured events to `console.debug` when enabled, exposes browser console helpers for enabling, disabling, inspecting, and clearing logs, persists browser debug mode through `localStorage`, and captures service events plus `fetch`, `invoke`, and `invokeAny` timings.
- b6c3fd8: Fix wallet-mode `useDelegation` dropping every resource except the top-level one. A multi-resource delegation (e.g. `[{tinycloud.kv get vault/secrets/X}, {tinycloud.encryption decrypt <networkId>}]`) carries each grant in `delegation.resources[]`, but the flat top-level `path`/`actions` mirror only the first resource. `useDelegation` built the activation sub-delegation's abilities from those flat fields alone, so for multi-resource delegations every other resource was silently dropped — the activated session held only the encryption cap and a subsequent `access.kv.get(...)` failed with `Unauthorized Action: .../tinycloud.kv/get`. Wallet-mode `useDelegation` now builds the activated abilities from the full `resources[]` set (kv/sql/duckdb scoped to the delegation space, encryption network URNs as raw abilities), so one `useDelegation` call grants every resource's capabilities.

  Also export the type-only barrel names `WasmKeyProviderConfig` and `NodeUserAuthorizationConfig` as `export type`, so importing node-sdk as raw TypeScript (e.g. via bun) no longer throws `SyntaxError: export 'X' not found`.

- Updated dependencies [6b554d6]
- Updated dependencies [0d397a8]
- Updated dependencies [895804a]
- Updated dependencies [6622043]
- Updated dependencies [75bebb1]
- Updated dependencies [79dd26c]
- Updated dependencies [eb44380]
- Updated dependencies [7603d1f]
- Updated dependencies [27f97d8]
- Updated dependencies [aa050d1]
- Updated dependencies [d4a0a69]
- Updated dependencies [a22a7f0]
- Updated dependencies [42f1235]
  - @tinycloud/sdk-core@2.4.0

## 2.4.0-beta.19

### Patch Changes

- 42f1235: Add an opt-in TinyCloud debug logger controlled by `TinyCloud_debug`. The logger keeps a 1000-event in-memory ring buffer, writes structured events to `console.debug` when enabled, exposes browser console helpers for enabling, disabling, inspecting, and clearing logs, persists browser debug mode through `localStorage`, and captures service events plus `fetch`, `invoke`, and `invokeAny` timings.
- Updated dependencies [42f1235]
  - @tinycloud/sdk-core@2.4.0-beta.19

## 2.4.0-beta.18

### Patch Changes

- 08e292d: Thread `invokeAny` into `DelegatedAccess` so delegated sessions can form multi-action SQL invocations. `DelegatedAccess` previously built its `ServiceContext` with only the single-action `invoke`, so any SQL operation needing more than one action in a single `/invoke` — e.g. the migration runner's `ensureMigrationsTable`, which bundles a `CREATE TABLE` schema action with the tracking-row `write` — threw `SQL operation requires multiple permissions ... but this SDK runtime does not support multi-resource invocations`. `DelegatedAccess` now accepts an optional `invokeAny`, and both `TinyCloudNode` construction sites pass `wasmBindings.invokeAny`, mirroring how the top-level node session already wires it.

## 2.4.0-beta.17

### Patch Changes

- 6622043: Expose `account.index.ensure()` and `tc account index ensure` for lightweight account SQLite schema bootstrap, and start schema bootstrap with background account registry sync.
- Updated dependencies [6622043]
  - @tinycloud/sdk-core@2.4.0-beta.17

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
  - @tinycloud/sdk-core@2.4.0-beta.16

## 2.4.0-beta.15

### Patch Changes

- @tinycloud/sdk-core@2.4.0-beta.15

## 2.4.0-beta.14

### Patch Changes

- a22a7f0: Rename the SDK-emitted SQL schema-change permission from `tinycloud.sql/ddl` to `tinycloud.sql/schema`, including manifest defaults and account-registry grants.

  TinyCloudWeb now treats a restored persisted session as stale when it does not cover the currently configured manifest permissions, then runs the normal manifest sign-in flow instead of letting apps request those manifest permissions separately after login.

- Updated dependencies [a22a7f0]
  - @tinycloud/sdk-core@2.4.0-beta.14

## 2.4.0-beta.13

### Patch Changes

- Updated dependencies [7603d1f]
  - @tinycloud/sdk-core@2.4.0-beta.13

## 2.4.0-beta.12

### Patch Changes

- fa4a7c7: Add regression coverage for SQL migration batches that require both `tinycloud.sql/ddl` and `tinycloud.sql/write`, including the legacy-session runtime permission repair path used by TinyCloud Secrets.
  - @tinycloud/sdk-core@2.4.0-beta.12

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
  - @tinycloud/sdk-core@2.4.0-beta.11

## 2.4.0-beta.10

### Minor Changes

- 27f97d8: Add a public `ensureOwnedSpaceHosted(name)` method to `TinyCloudNode` and `TinyCloudWeb` for hosting an owner's owned space (e.g. `"secrets"`) from a session created with a manifest / capabilityRequest.

  A full-authority sign-in auto-hosts the owner's `secrets` space, but a session created with a manifest / capabilityRequest does not. Such a session could hold valid `tinycloud.kv/*` capabilities for the owned `secrets` space yet still fail its first scoped `secrets.put(...)` with `404 Space not found`, because the space was never registered on the node. `ensureOwnedSpaceHosted(name)` resolves the name to the owner's owned-space URI and hosts it via the host-SIWE delegation flow (one signature, idempotent server-side), so subsequent scoped secret writes succeed.

### Patch Changes

- d4a0a69: Add a SQL migrations helper on database handles: `sql.db(name).migrations.apply({ namespace, migrations })`. The helper records applied migration ids in a TinyCloud-managed table, signs migration DDL/write/read actions through the SQL service, and returns whether migrations were applied or already current.

  The account registry index now uses the migrations helper for its schema setup, and SQL/DuckDB service errors sanitize non-JSON proxy HTML pages into concise retryable messages while preserving a bounded debug snippet in error metadata.

- Updated dependencies [27f97d8]
- Updated dependencies [d4a0a69]
  - @tinycloud/sdk-core@2.4.0-beta.10

## 2.4.0-beta.9

### Patch Changes

- 0d397a8: Treat the account SQLite index as a materialized cache for user-facing account reads. Account application, space, and delegation list calls can now prefer the index while falling back to canonical account data when index tables are missing or empty, and account writes no longer fail when a best-effort index update fails.
- Updated dependencies [0d397a8]
  - @tinycloud/sdk-core@2.4.0-beta.9

## 2.4.0-beta.8

### Patch Changes

- 895804a: Include `tinycloud.sql/ddl` in the implicit account registry index permission and legacy default SQL grant so account registry writes can create their SQLite tables and indexes on first use. SQL execute and batch calls now sign DDL statements with `tinycloud.sql/ddl`, and mixed batches sign with every required SQL action instead of collapsing to write-only.
- Updated dependencies [895804a]
  - @tinycloud/sdk-core@2.4.0-beta.8

## 2.4.0-beta.7

### Minor Changes

- 75bebb1: Add account registry write-through indexing, account space registry APIs, and matching `tc account spaces` / `tc account index status` CLI commands.

  Manifest registration now records an indexed manifest hash and skips durable KV rewrites when the indexed record is current. Sign-in schedules best-effort background registry sync for application manifests and accessible spaces, while every discovered or hosted space is written through to the account registry index.

### Patch Changes

- Updated dependencies [75bebb1]
  - @tinycloud/sdk-core@2.4.0-beta.7

## 2.4.0-beta.6

### Minor Changes

- 6b554d6: Add shared account APIs for applications and delegations, expose them from the node and web SDK clients, and add the `tc account` CLI command group.

### Patch Changes

- Updated dependencies [6b554d6]
  - @tinycloud/sdk-core@2.4.0-beta.6

## 2.4.0-beta.5

### Patch Changes

- 7c5fe21: Automatically ensure owner-owned encryption networks exist during manifest-driven sign-in. When a requested `tinycloud.encryption/decrypt` permission targets the signed-in user's network ID, the SDK adds a separate scoped `tinycloud.encryption/network.create` sign-in grant and `signIn()` creates the network if the node reports it missing.

## 2.4.0-beta.3

### Patch Changes

- 8e8f7e8: Fix runtime permission grants silently failing to match across EIP-155 address-case differences.

  `TinyCloudNode.operationCovers` compared a runtime grant's `spaceId` against the requested operation's `spaceId` byte-for-byte. Stored runtime delegations (e.g. from `tc auth request --grant`, replayed on every node create) keep the EIP-55 **checksummed** address, while a space URI built by the CLI is **lowercased** — so a valid granted capability never matched and the invocation fell back to the base session, surfacing as a spurious `401 AUTH_UNAUTHORIZED` ("active session missing capability") even though `tc auth caps` showed the cap.

  Ethereum addresses are case-insensitive; space comparison now lowercases ONLY the `eip155:<chain>:0x<addr>` address segment before comparing, leaving the case-sensitive space NAME byte-exact. This is the runtime-grant analogue of the CLI-layer `OPENKEY_SCOPE_MISMATCH` fix (`normalizeSpaceForCompare`).

## 2.4.0-beta.2

### Minor Changes

- 934534d: Auth/hosting developer experience for the delegate-asks-owner-to-host model.
  - **`tc space host-request <name> --emit <file>`** (delegate-only): emits a `tinycloud.host.request` artifact naming the space and its resolved owner DID so an agent can surface it to the owner, who then runs `tc space host <name>`. If the caller IS the root authority of the resolved space, it refuses (`ALREADY_ROOT_AUTHORITY`) and tells them to host directly — no request is emitted. The command is a pure local emit and never contacts the node.
  - **Identity-aware `SPACE_NOT_HOSTED`**: an unhosted-space write/read previously surfaced as an opaque `404 - Space not found`. The kv and sql commands now normalize **only** that exact condition (404 + "Space not found" body) to a `SPACE_NOT_HOSTED` error carrying an identity-aware `hint`. The branch key `is_root_authority(space, active session)` is computed locally from the profile address + space DID (no network): the owner is told to run `tc space host <name>`, a delegate is told they cannot host and to emit `tc space host-request <name> --emit`. A wrong db/table/path or permission error is left untouched. A `delegate-session` profile is never treated as the root authority even when its stored ownerDid is the space owner, so a delegate always gets the host-request hint. `KVService` get/head/delete now preserve the `Space not found` 404 body (previously collapsed to `KV_NOT_FOUND` before the body was read), so unhosted-space **reads** normalize too, while a genuine missing key still reports `KV_NOT_FOUND`.
  - **SDK `grantAuthRequest(authority, request, options?)`** (`@tinycloud/node-sdk`): takes a delegation request artifact and returns a grant artifact (`tinycloud.auth.delegation`) by signing through `delegateTo`, so the request→grant handshake is callable programmatically. `tc auth grant` is now a thin wrapper over it. Adds the `AuthRequestArtifact`, `AuthDelegationArtifact`, and `DelegationAuthority` types.

### Patch Changes

- @tinycloud/sdk-core@2.4.0-beta.2

## 2.4.0-beta.1

### Minor Changes

- 0e8ccc6: Add `TinyCloudNode.hostOwnedSpace(name)` and wire `tc space create`/`tc space host` to it.

  Hosting an owned space (e.g. `applications`) by name now registers it on the server via the host-SIWE delegation flow, so subsequent KV/SQL writes to that space succeed instead of returning `404 - Space not found`. Unlike the internal `ensureOwnedSpaceHosted`, this always submits the host delegation rather than inferring hosting from session activation — a space the current session has never referenced is reported neither `activated` nor `skipped`, which previously caused the host to be silently skipped. The host SIWE is idempotent server-side, so re-hosting an existing space is a safe no-op.

  The `tc space create <name>` command (which previously POSTed the unsupported `tinycloud.space/create` action and failed with `401 Unauthorized`) now hosts the caller's owned space; `tc space host <name>` is added as an alias.

### Patch Changes

- @tinycloud/sdk-core@2.4.0-beta.1

## 2.3.1-beta.0

### Patch Changes

- b6c3fd8: Fix wallet-mode `useDelegation` dropping every resource except the top-level one. A multi-resource delegation (e.g. `[{tinycloud.kv get vault/secrets/X}, {tinycloud.encryption decrypt <networkId>}]`) carries each grant in `delegation.resources[]`, but the flat top-level `path`/`actions` mirror only the first resource. `useDelegation` built the activation sub-delegation's abilities from those flat fields alone, so for multi-resource delegations every other resource was silently dropped — the activated session held only the encryption cap and a subsequent `access.kv.get(...)` failed with `Unauthorized Action: .../tinycloud.kv/get`. Wallet-mode `useDelegation` now builds the activated abilities from the full `resources[]` set (kv/sql/duckdb scoped to the delegation space, encryption network URNs as raw abilities), so one `useDelegation` call grants every resource's capabilities.

  Also export the type-only barrel names `WasmKeyProviderConfig` and `NodeUserAuthorizationConfig` as `export type`, so importing node-sdk as raw TypeScript (e.g. via bun) no longer throws `SyntaxError: export 'X' not found`.

## 2.3.0

### Minor Changes

- fb96a1e: Rename owner/delegate identity surfaces from primary/principal terminology to owner terminology.

  CLI profiles and auth request artifacts now use `ownerDid` and `sessionDid`. Encryption network descriptors and discovery APIs now expose the owner identity as `ownerDid`.

- c7676d6: Add `kv.batchPut` for one-invocation TinyCloud KV batch writes.

### Patch Changes

- 9ee7404: Harden encryption-network decrypt flows, add CLI secrets coverage, and fix web WASM initialization.
- a92819d: Add canonical EVM address and `did:pkh:eip155` helpers, then use them when building and comparing TinyCloud DIDs and space IDs.
- 90bdc18: Add canonical encryption network ID helpers so apps can compare network-scoped capabilities across equivalent owner DID address casing.
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

- ddab8fa: Add `TinyCloudNode.kvForSpace(spaceId)` and a `--space` option on `tc kv get/list/head`, mirroring the existing `sqlForSpace` / `tc sql --space`. This lets KV reads target a non-primary space — e.g. reading a manifest app's data kept under the owner's `applications` space (such as Listen's transcripts at `applications/kv/<app-id>/transcript/<id>`) when the session already holds a covering delegation.
- d606baf: Accept equivalent `did:pkh:eip155` owner DID address casing when validating encryption network descriptors, including legacy `principal` descriptors, so `tc secrets` can read existing network metadata. Pin the Rust WASM source to the released `tinycloud-node` `v1.4.2` tag.
- f11e468: Add default-off telemetry configuration and named span timing events for SDK operations.
- Updated dependencies [a92819d]
- Updated dependencies [90bdc18]
- Updated dependencies [f615a19]
- Updated dependencies [fb96a1e]
- Updated dependencies [d606baf]
- Updated dependencies [c7676d6]
- Updated dependencies [f11e468]
  - @tinycloud/sdk-core@2.3.0
  - @tinycloud/node-sdk-wasm@1.7.4

## 2.3.0-beta.8

### Patch Changes

- ddab8fa: Add `TinyCloudNode.kvForSpace(spaceId)` and a `--space` option on `tc kv get/list/head`, mirroring the existing `sqlForSpace` / `tc sql --space`. This lets KV reads target a non-primary space — e.g. reading a manifest app's data kept under the owner's `applications` space (such as Listen's transcripts at `applications/kv/<app-id>/transcript/<id>`) when the session already holds a covering delegation.
- f11e468: Add default-off telemetry configuration and named span timing events for SDK operations.
- Updated dependencies [f11e468]
  - @tinycloud/sdk-core@2.3.0-beta.8

## 2.3.0-beta.7

### Patch Changes

- @tinycloud/sdk-core@2.3.0-beta.7

## 2.3.0-beta.6

### Minor Changes

- c7676d6: Add `kv.batchPut` for one-invocation TinyCloud KV batch writes.

### Patch Changes

- Updated dependencies [c7676d6]
  - @tinycloud/sdk-core@2.3.0-beta.6

## 2.3.0-beta.5

### Patch Changes

- d606baf: Accept equivalent `did:pkh:eip155` owner DID address casing when validating encryption network descriptors, including legacy `principal` descriptors, so `tc secrets` can read existing network metadata. Pin the Rust WASM source to the released `tinycloud-node` `v1.4.2` tag.
- Updated dependencies [d606baf]
  - @tinycloud/node-sdk-wasm@1.7.4-beta.1
  - @tinycloud/sdk-core@2.3.0-beta.5

## 2.3.0-beta.4

### Patch Changes

- 90bdc18: Add canonical encryption network ID helpers so apps can compare network-scoped capabilities across equivalent owner DID address casing.
- Updated dependencies [90bdc18]
  - @tinycloud/sdk-core@2.3.0-beta.4

## 2.3.0-beta.3

### Patch Changes

- a92819d: Add canonical EVM address and `did:pkh:eip155` helpers, then use them when building and comparing TinyCloud DIDs and space IDs.
- Updated dependencies [a92819d]
  - @tinycloud/sdk-core@2.3.0-beta.3

## 2.3.0-beta.2

### Minor Changes

- fb96a1e: Rename owner/delegate identity surfaces from primary/principal terminology to owner terminology.

  CLI profiles and auth request artifacts now use `ownerDid` and `sessionDid`. Encryption network descriptors and discovery APIs now expose the owner identity as `ownerDid`.

### Patch Changes

- Updated dependencies [fb96a1e]
  - @tinycloud/sdk-core@2.3.0-beta.2

## 2.2.1-beta.1

### Patch Changes

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

## 2.2.1-beta.0

### Patch Changes

- 9ee7404: Harden encryption-network decrypt flows, add CLI secrets coverage, and fix web WASM initialization.
- Updated dependencies [f615a19]
  - @tinycloud/node-sdk-wasm@1.7.4-beta.0
  - @tinycloud/sdk-core@2.2.1-beta.0

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

- 6561589: Add manifest v1 composition helpers, per-space capability requests, materialized manifest delegations, and the default account-space application registry grant.
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

- 8367cef: Store approved runtime permissions as narrow portable delegations and route matching invocations through them instead of expanding the app manifest and re-signing the whole session. `delegateTo()` can now derive from an installed runtime delegation, web permission requests return any created runtime delegations, and the secrets wrapper can use the SDK's connected signer when unlocking the backing vault.
- 35212bb: Add canonical scoped secret support. Manifest `secrets` entries now accept object specs with `scope` and optional `name`, and `tc.secrets` supports scoped `get`, `put`, `delete`, and `list` calls using the canonical `secrets/scoped/<scope>/<NAME>` vault layout.
- 46f126a: Add manifest `secrets` declarations and SDK helpers backed by the secrets space vault, including read-default permissions and write/delete escalation.
- f43143d: TC-1372: add `kv.createSignedReadUrl()` for minting short-lived signed KV read URLs through tinycloud-node's `/signed/kv` endpoint.

  The method signs a normal `tinycloud.kv/get` invocation for the resolved key path, posts the signed URL request to tinycloud-node, and returns an absolute URL plus the opaque ticket id and expiry metadata. Requires tinycloud-node with the TC-1368 signed KV URL API.

  The default signed read URL expiry is defined in `sdk-core` as
  `EXPIRY.SIGNED_READ_URL_MS` and exposed as
  `DEFAULT_SIGNED_READ_URL_EXPIRY_MS`.

- 78ef7eb: Add `tinycloud.vault` as an SDK permission shorthand that expands to the backing KV permissions used by encrypted vault operations, including runtime permission escalation.

### Patch Changes

- 9ab4644: Check whether the manifest account registry space already exists before hosting it during sign-in, avoiding repeated account-space host prompts.
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

- 04a0d5c: Expose `DelegatedAccess.restorable` — a read-only projection of the activated session handles (`delegationHeader`, `delegationCid`, `spaceId`, `jwk`, `verificationMethod`, `address`, `chainId`) in the exact shape `TinyCloudNode.restoreSession(...)` consumes. Enables persisting a `useDelegation` activation across processes or restarts (e.g. agent runtimes that want vanilla `@tinycloud/cli` to operate against a delegated space). Note: in wallet mode the header/cid are minted against the activator's server-side session and expire with it (~1h), so callers must periodically re-run `useDelegation` + `restoreSession`.
- b9a24b5: Add implicit space-level `tinycloud.capabilities/read` grants for every space touched by a manifest request.
- Updated dependencies [0401ff8]
- Updated dependencies [0e049d7]
- Updated dependencies [9dc2e8c]
- Updated dependencies [9ff4b34]
- Updated dependencies [2305a65]
- Updated dependencies [b9a24b5]
- Updated dependencies [de4d662]
- Updated dependencies [6561589]
- Updated dependencies [35212bb]
- Updated dependencies [46f126a]
- Updated dependencies [f43143d]
- Updated dependencies [78ef7eb]
  - @tinycloud/sdk-core@2.2.0
  - @tinycloud/node-sdk-wasm@1.7.3

## 2.2.0-beta.13

### Patch Changes

- @tinycloud/sdk-core@2.2.0-beta.13

## 2.2.0-beta.12

### Minor Changes

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

- f43143d: TC-1372: add `kv.createSignedReadUrl()` for minting short-lived signed KV read URLs through tinycloud-node's `/signed/kv` endpoint.

  The method signs a normal `tinycloud.kv/get` invocation for the resolved key path, posts the signed URL request to tinycloud-node, and returns an absolute URL plus the opaque ticket id and expiry metadata. Requires tinycloud-node with the TC-1368 signed KV URL API.

  The default signed read URL expiry is defined in `sdk-core` as
  `EXPIRY.SIGNED_READ_URL_MS` and exposed as
  `DEFAULT_SIGNED_READ_URL_EXPIRY_MS`.

### Patch Changes

- Updated dependencies [0e049d7]
- Updated dependencies [f43143d]
  - @tinycloud/node-sdk-wasm@1.7.3-beta.2
  - @tinycloud/sdk-core@2.2.0-beta.12

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

- Updated dependencies [9ff4b34]
  - @tinycloud/sdk-core@2.2.0-beta.11

## 2.2.0-beta.10

### Minor Changes

- 35212bb: Add canonical scoped secret support. Manifest `secrets` entries now accept object specs with `scope` and optional `name`, and `tc.secrets` supports scoped `get`, `put`, `delete`, and `list` calls using the canonical `secrets/scoped/<scope>/<NAME>` vault layout.

### Patch Changes

- Updated dependencies [35212bb]
  - @tinycloud/sdk-core@2.2.0-beta.10

## 2.2.0-beta.9

### Minor Changes

- 78ef7eb: Add `tinycloud.vault` as an SDK permission shorthand that expands to the backing KV permissions used by encrypted vault operations, including runtime permission escalation.

### Patch Changes

- Updated dependencies [78ef7eb]
  - @tinycloud/sdk-core@2.2.0-beta.9

## 2.2.0-beta.8

### Minor Changes

- 8367cef: Store approved runtime permissions as narrow portable delegations and route matching invocations through them instead of expanding the app manifest and re-signing the whole session. `delegateTo()` can now derive from an installed runtime delegation, web permission requests return any created runtime delegations, and the secrets wrapper can use the SDK's connected signer when unlocking the backing vault.

## 2.2.0-beta.7

### Minor Changes

- 46f126a: Add manifest `secrets` declarations and SDK helpers backed by the secrets space vault, including read-default permissions and write/delete escalation.

### Patch Changes

- Updated dependencies [46f126a]
  - @tinycloud/sdk-core@2.2.0-beta.7

## 2.2.0-beta.6

### Patch Changes

- b9a24b5: Add implicit space-level `tinycloud.capabilities/read` grants for every space touched by a manifest request.
- Updated dependencies [b9a24b5]
  - @tinycloud/sdk-core@2.2.0-beta.6

## 2.2.0-beta.5

### Patch Changes

- 9ab4644: Check whether the manifest account registry space already exists before hosting it during sign-in, avoiding repeated account-space host prompts.
- Updated dependencies [9dc2e8c]
  - @tinycloud/node-sdk-wasm@1.7.3-beta.1

## 2.2.0-beta.4

### Minor Changes

- 0401ff8: Add default TinyCloud host discovery and run it from sign-in when no explicit host is configured.

### Patch Changes

- Updated dependencies [0401ff8]
  - @tinycloud/sdk-core@2.2.0-beta.4

## 2.2.0-beta.3

### Patch Changes

- Updated dependencies [2305a65]
  - @tinycloud/sdk-core@2.2.0-beta.3

## 2.2.0-beta.2

### Patch Changes

- 04a0d5c: Expose `DelegatedAccess.restorable` — a read-only projection of the activated session handles (`delegationHeader`, `delegationCid`, `spaceId`, `jwk`, `verificationMethod`, `address`, `chainId`) in the exact shape `TinyCloudNode.restoreSession(...)` consumes. Enables persisting a `useDelegation` activation across processes or restarts (e.g. agent runtimes that want vanilla `@tinycloud/cli` to operate against a delegated space). Note: in wallet mode the header/cid are minted against the activator's server-side session and expire with it (~1h), so callers must periodically re-run `useDelegation` + `restoreSession`.

## 2.2.0-beta.1

### Patch Changes

- Updated dependencies [de4d662]
  - @tinycloud/sdk-core@2.2.0-beta.1

## 2.2.0-beta.0

### Minor Changes

- 6561589: Add manifest v1 composition helpers, per-space capability requests, materialized manifest delegations, and the default account-space application registry grant.

### Patch Changes

- Updated dependencies [6561589]
  - @tinycloud/sdk-core@2.2.0-beta.0
  - @tinycloud/node-sdk-wasm@1.7.3-beta.0

## 2.1.0

### Minor Changes

- 8abfb4e: Bump past stale `2.1.0-beta.0` / `1.7.2-beta.0` ghost versions to publish PR #184's capability-chain delegation code.

  The earlier `2.1.0-beta.0` (TS SDKs) and `1.7.2-beta.0` (WASM) tarballs on npm predate PR #184 and are missing `resolveManifest`, `isCapabilitySubset`, manifest types, and the `parseRecapFromSiwe` re-export. This empty changeset forces `changeset version` to land on the next beta counter so the Beta Release workflow actually publishes the post-#184 code.

  All four TS packages in the linked group are named explicitly so `@tinycloud/sdk-services` advances too (naming only `@tinycloud/sdk-core` left it pinned at the ghost `2.1.0-beta.0`). Both WASM wrappers take a patch bump so the TS SDKs don't pin a stale `@tinycloud/*-sdk-wasm@1.7.2-beta.0`.

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

- 4fac901: Publish the UCAN delegation header fix from PR #192.

  `createDelegationViaWasmPath` now activates session-key UCAN delegations with
  the raw serialized JWT in the `Authorization` header instead of prefixing it
  with `Bearer `. The TinyCloud host decodes this header directly as a UCAN JWT;
  the prefixed value causes host activation to fail with 401 during
  manifest-driven `delegateTo` flows such as TinyBoilerplate/OpenKey sign-in.

- fb1d3fd: Trigger republish after CI auth fix — nonce passthrough fix shipped in prior beta was not published to npm due to broken publish step.
- Updated dependencies [303a8eb]
- Updated dependencies [8abfb4e]
- Updated dependencies [b55ffbd]
- Updated dependencies [b88728a]
- Updated dependencies [c586568]
- Updated dependencies [9dad135]
- Updated dependencies [9a9fae1]
- Updated dependencies [fb1d3fd]
- Updated dependencies [61c031d]
  - @tinycloud/sdk-core@2.1.0
  - @tinycloud/node-sdk-wasm@1.7.2

## 2.1.0-beta.6

### Patch Changes

- 4fac901: Publish the UCAN delegation header fix from PR #192.

  `createDelegationViaWasmPath` now activates session-key UCAN delegations with
  the raw serialized JWT in the `Authorization` header instead of prefixing it
  with `Bearer `. The TinyCloud host decodes this header directly as a UCAN JWT;
  the prefixed value causes host activation to fail with 401 during
  manifest-driven `delegateTo` flows such as TinyBoilerplate/OpenKey sign-in.

## 2.1.0-beta.5

### Patch Changes

- 303a8eb: Add an optional per-call `nonce` override to `signIn()` while preserving constructor-level `siweConfig.nonce` support.
- Updated dependencies [303a8eb]
  - @tinycloud/sdk-core@2.1.0-beta.5

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
  - @tinycloud/sdk-core@2.1.0-beta.4

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
  - @tinycloud/sdk-core@2.1.0-beta.3

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

### Patch Changes

- Updated dependencies [9dad135]
  - @tinycloud/sdk-core@2.1.0-beta.2
  - @tinycloud/node-sdk-wasm@1.7.2-beta.2

## 2.1.0-beta.1

### Minor Changes

- 8abfb4e: Bump past stale `2.1.0-beta.0` / `1.7.2-beta.0` ghost versions to publish PR #184's capability-chain delegation code.

  The earlier `2.1.0-beta.0` (TS SDKs) and `1.7.2-beta.0` (WASM) tarballs on npm predate PR #184 and are missing `resolveManifest`, `isCapabilitySubset`, manifest types, and the `parseRecapFromSiwe` re-export. This empty changeset forces `changeset version` to land on the next beta counter so the Beta Release workflow actually publishes the post-#184 code.

  All four TS packages in the linked group are named explicitly so `@tinycloud/sdk-services` advances too (naming only `@tinycloud/sdk-core` left it pinned at the ghost `2.1.0-beta.0`). Both WASM wrappers take a patch bump so the TS SDKs don't pin a stale `@tinycloud/*-sdk-wasm@1.7.2-beta.0`.

### Patch Changes

- Updated dependencies [8abfb4e]
  - @tinycloud/sdk-core@2.1.0-beta.1
  - @tinycloud/node-sdk-wasm@1.7.2-beta.1

## 2.1.0-beta.0

### Minor Changes

- 61c031d: Add write-hooks support across the JS SDK surface for SDK services, core, Node, and web packages.

### Patch Changes

- Updated dependencies [b55ffbd]
- Updated dependencies [9a9fae1]
- Updated dependencies [61c031d]
  - @tinycloud/sdk-core@2.1.0-beta.0
  - @tinycloud/node-sdk-wasm@1.7.2-beta.0

## 2.0.4-beta.0

### Patch Changes

- fb1d3fd: Trigger republish after CI auth fix — nonce passthrough fix shipped in prior beta was not published to npm due to broken publish step.
- Updated dependencies [fb1d3fd]
  - @tinycloud/sdk-core@2.0.4-beta.0

## 2.0.3

### Patch Changes

- e7e6ee7: Fix SIWE domain to default to app.tinycloud.xyz instead of TinyCloud node URL
- 1379b11: Preserve `siweConfig` when upgrading from session-only mode via `connectWallet()` or `connectSigner()`
- e422647: Add top-level `nonce` field to `ClientConfig` / `TinyCloudNodeConfig` and ship the WASM rev bump carrying the SIWE nonce passthrough fix from tinycloud-node.
  - **WASM rev bump (previously merged without a changeset)**: `@tinycloud/sdk-rs` now tracks a tinycloud-node revision that accepts `nonce` in `SessionConfig`. Before this rev, `siweConfig.nonce` was forwarded by the TypeScript layer but silently dropped inside the Rust WASM layer. Single-signature auth flows that rely on server-provided nonces (e.g. billing sidecars) now work end-to-end.
  - **New top-level `nonce` field**: Callers can now pass `nonce` directly on `ClientConfig` / `TinyCloudNodeConfig` instead of nesting it under `siweConfig`. Precedence is `siweConfig.nonce` > top-level `nonce` > random (generated by the WASM layer), so `siweConfig.nonce` still wins when both are set. Omitting both preserves existing behavior.

- Updated dependencies [c2f2d54]
- Updated dependencies [e422647]
  - @tinycloud/sdk-core@2.0.3
  - @tinycloud/node-sdk-wasm@1.7.1

## 2.0.3-beta.3

### Patch Changes

- 1379b11: Preserve `siweConfig` when upgrading from session-only mode via `connectWallet()` or `connectSigner()`
- e422647: Add top-level `nonce` field to `ClientConfig` / `TinyCloudNodeConfig` and ship the WASM rev bump carrying the SIWE nonce passthrough fix from tinycloud-node.
  - **WASM rev bump (previously merged without a changeset)**: `@tinycloud/sdk-rs` now tracks a tinycloud-node revision that accepts `nonce` in `SessionConfig`. Before this rev, `siweConfig.nonce` was forwarded by the TypeScript layer but silently dropped inside the Rust WASM layer. Single-signature auth flows that rely on server-provided nonces (e.g. billing sidecars) now work end-to-end.
  - **New top-level `nonce` field**: Callers can now pass `nonce` directly on `ClientConfig` / `TinyCloudNodeConfig` instead of nesting it under `siweConfig`. Precedence is `siweConfig.nonce` > top-level `nonce` > random (generated by the WASM layer), so `siweConfig.nonce` still wins when both are set. Omitting both preserves existing behavior.

- Updated dependencies [e422647]
  - @tinycloud/sdk-core@2.0.3-beta.3

## 2.0.3-beta.2

### Patch Changes

- Updated dependencies [c2f2d54]
  - @tinycloud/sdk-core@2.0.3-beta.2

## 2.0.3-beta.0

### Patch Changes

- e7e6ee7: Fix SIWE domain to default to app.tinycloud.xyz instead of TinyCloud node URL

## 2.0.2

### Patch Changes

- 3401b3c: Fix siweConfig.nonce passthrough to SIWE message generation

  The nonce field from siweConfig was accepted in the configuration but never
  forwarded to the WASM prepareSession() call, causing server-provided nonces
  to be silently ignored. This broke single-signature auth flows where an
  external service (e.g. billing sidecar) provides a nonce for verification.

- Updated dependencies [7bb188f]
  - @tinycloud/sdk-core@2.0.2

## 2.0.1

### Patch Changes

- @tinycloud/sdk-core@2.0.1

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

### Patch Changes

- Updated dependencies [6eebc29]
  - @tinycloud/sdk-core@2.0.0

## 1.7.0

### Patch Changes

- def099d: Skip redundant public key writes on vault unlock and auto-include public-space KV delegation when creating delegations with KV actions. Remove unused VaultAction constants.
- Updated dependencies [8649de8]
  - @tinycloud/node-sdk-wasm@1.7.0
  - @tinycloud/sdk-core@1.7.0
  - @tinycloud/web-core@1.7.0

## 1.6.0

### Minor Changes

- db50ae4: Add DuckDB service to the TypeScript SDK. Provides `tc.duckdb` for querying and managing DuckDB databases on TinyCloud nodes, including `query()`, `queryArrow()`, `execute()`, `batch()`, `describe()`, `export()`, and `import()` operations. Named database handles via `tc.duckdb.database()`. SDK services are now conditionally initialized based on node feature detection — accessing an unsupported service throws `UnsupportedFeatureError`.

### Patch Changes

- Updated dependencies [9454b78]
- Updated dependencies [db50ae4]
- Updated dependencies [bea6063]
  - @tinycloud/sdk-core@1.6.0
  - @tinycloud/node-sdk-wasm@1.6.0
  - @tinycloud/web-core@1.6.0

## 1.5.0

### Patch Changes

- @tinycloud/sdk-core@1.5.0

## 1.4.1

### Patch Changes

- Updated dependencies [da5a499]
  - @tinycloud/node-sdk-wasm@1.4.1

## 1.4.0

### Minor Changes

- fd25623: Add browser-based delegate auth flow for CLI login via OpenKey. The CLI opens a `/delegate` page where users authenticate with a passkey, select a key, and approve a delegation. `TinyCloudNode.restoreSession()` allows injecting stored delegation data without a private key. Also fixes `kv list` result parsing and CLI process hang after auth.

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
- Updated dependencies [94ad509]
- Updated dependencies [94ad509]
- Updated dependencies [94ad509]
- Updated dependencies [94ad509]
  - @tinycloud/sdk-core@1.3.0

## 1.2.0

### Minor Changes

- 2014a20: Add sessionStorage to TinyCloudNodeConfig types and switch build to tsup for proper ESM/CJS output
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

- Updated dependencies [bcbebbe]
- Updated dependencies [ca9b2c6]
  - @tinycloud/sdk-core@1.2.0

## 1.1.0

### Patch Changes

- Updated dependencies [855e0d9]
- Updated dependencies [ba988fb]
  - @tinycloud/sdk-core@1.1.0
  - @tinycloud/web-core@1.1.0

## 1.0.1

### Patch Changes

- Updated dependencies [c97e40d]
  - @tinycloud/node-sdk-wasm@1.0.1
  - @tinycloud/web-core@1.0.1
  - @tinycloud/sdk-core@1.0.1

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

- Updated dependencies [b863afb]
- Updated dependencies [866981c]
  - @tinycloudlabs/sdk-core@1.0.0
  - @tinycloudlabs/web-core@1.0.0
  - @tinycloudlabs/node-sdk-wasm@1.0.0

## 0.2.0

### Minor Changes

- a2b4b66: Breaking API changes for node-sdk delegation system

  ### node-sdk

  **BREAKING: `allowSubDelegation` → `disableSubDelegation`**
  - Sub-delegation is now allowed by default (aligns with ocap/UCAN expectations)
  - Use `disableSubDelegation: true` to prevent recipients from creating sub-delegations
  - Before: `createDelegation({ allowSubDelegation: true })` to enable
  - After: `createDelegation({})` enables by default, use `disableSubDelegation: true` to disable

  **BREAKING: `autoCreateNamespace` default changed to `false`**
  - Namespaces are no longer auto-created during sign-in
  - Use `autoCreateNamespace: true` explicitly for namespace owners
  - Delegates using shared namespaces should not set this flag

  ### web-sdk
  - Fixed `KVServiceAdapter` to include `jwk` property required by `ServiceSession`

### Patch Changes

- a2b4b66: Create node-sdk package with Node.js-specific TinyCloud SDK implementations.

  This package provides:
  - `PrivateKeySigner`: ISigner implementation using private keys via WASM
  - `NodeUserAuthorization`: IUserAuthorization with configurable sign strategies
    - auto-sign: Automatically approve all sign requests
    - auto-reject: Reject all sign requests
    - callback: Delegate to custom callback function
    - event-emitter: Emit sign requests as events
  - `MemorySessionStorage`: In-memory ISessionStorage
  - `FileSessionStorage`: File-based ISessionStorage for session persistence

  Part of TC-401: IUserAuthorization shared interface implementation.

- a2b4b66: Fix delegation chain support for user-to-user delegations
  - Added `pkhDid` getter for PKH DID format (`did:pkh:eip155:{chainId}:{address}`)
  - Fixed `createDelegation` to use `delegateUri` for targeting recipient's PKH DID
  - Fixed `createSubDelegation` to use `delegateUri` instead of generating random JWK
  - Fixed sub-delegation expiry to cap at parent's expiry instead of throwing error
  - Updated demo to use `pkhDid` for all delegations

  Full delegation chain now works: Alice → Bob → Charlie

- Updated dependencies [a2b4b66]
- Updated dependencies [a2b4b66]
- Updated dependencies [a2b4b66]
  - @tinycloudlabs/sdk-core@0.2.0
  - @tinycloudlabs/node-sdk-wasm@0.1.1
  - @tinycloudlabs/web-core@0.3.1
