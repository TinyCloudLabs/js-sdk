# Generic credential acquisition

`TinyCloudWeb.credentials` is bound to the initialized client's active session. It never creates a second identity and stores only in that holder's existing `credentials` space.

```ts
const requirement = {
  type: "TinyCloudCredentialRequirement",
  version: 1,
  profile: { id: "tinycloud.email-proof/v1", version: 1 },
  credentialType: { id: "opencredentials.email/v1", version: 1 },
  claims: { email: "reader@example.test" },
} as const;

const result = await tinycloud.credentials.ensure(requirement, {
  descriptor: pinnedDescriptor,
  interaction: "popup",
  signal: abortController.signal,
  onProgress: ({ state }) => renderProgress(state),
});
```

A pinned descriptor is executed without discovery. If discovery is desired, pass an explicit canonical `/.well-known/opencredentials` or `/v1/credential-types` URL instead.

`ensure` performs lookup, current-record revalidation, acquisition when missing, independent SD-JWT and issuer verification, atomic record/index storage, and authenticated read-after-write receipt validation. `find`, `acquire`, `verify`, and `store` expose those stages for advanced hosts.

The popup URL contains only the opaque request locator. Popup messages contain only `{ type, version, locator }` wake signals. The completion verifier remains in the SDK and authenticates status and result requests in a header. The active session performs holder signing and storage; private keys, session tokens, OTPs, identifiers, and credentials are never exported to URLs or messages.

The interpreter dispatches only `collect_input@1`, `mailbox_otp@1`, and `holder_signature@1`. It never compares credential or profile names. Hosts can supply headless primitive handlers or bounded renderer models from `renderCredentialDescriptor`; presentation metadata cannot change endpoint selection, proof ordering, signing text, or authority.

## Inline host boundary

`interaction: "inline"` requires a host-owned `InlineCredentialInteraction`. The SDK gives that adapter only an abort signal and declared proof-step metadata, never requirement values. The host returns locally entered proof values; the SDK alone sends them to OpenCredentials, performs holder signing, verifies the issued credential, and writes the holder-owned record. In particular, an inline host never receives an acquisition locator, completion verifier, transport function, TinyCloud session, signing capability, or policy value. Do not log or forward the proof value returned by `requestProof`.

The host owns the accessible form: use a programmatic label for every field, move focus to the heading or alert on state changes, keep the primary action reachable by keyboard, expose busy/error status with a live region, and keep controls usable at narrow viewport widths. `requestProof` may reject with `CredentialError("CANCELED", ...)` when the holder cancels; a recoverable credential error may be rendered with an explicit retry action that calls `ensure` again.

An inline surface is recreated for a resumed request so the current signed-in holder sees the same local UI after an interruption. The default inline path persists nothing. If a host explicitly supplies a redirect store, its request continuation is still bound to the active holder, descriptor, requirement, and origin; the host must supply the inline adapter again when calling `ensure` to resume it.

Failures are `CredentialError` values with stable `code` and `recoverable` fields. Issuance followed by an unconfirmed write is always `VERIFIED_NOT_SAVED`, never success. A blocked popup can be retried with `interaction: "redirect"` without changing holder or storage authority. Redirect mode keeps only its request-specific verifier and bindings in same-origin session storage; it never persists the TinyCloud session. Calling the same `ensure` operation after the host session is restored resumes that exact request, and mismatched holder, requirement, or descriptor state fails closed.

## Held email credentials: the storage grant an app needs

`listHeldEmailCredentials`, `findHeldCredential`, `storeHeldCredential`, `deleteHeldCredential`, `pruneHeldCredentials` and `acquireHeldCredential` (from `@tinycloud/web-sdk/credentials`) keep the account's held credentials in the **kv store of the app's primary space, under `v1/held/`** (one prefix per account). An app that signs in with a manifest only gets the kv access its manifest asks for, so the manifest must request it. Without it the node answers 401 and the call fails with `PERMISSION_DENIED`:

```json
{
  "service": "tinycloud.kv",
  "path": "v1/held/",
  "actions": ["get", "list", "put", "del"],
  "skipPrefix": true
}
```

- `get` and `list` read the credentials: `listHeldEmailCredentials`, `findHeldCredential`, `pruneHeldCredentials` (it lists and reads every record before it deletes any), and the read that `acquireHeldCredential` does before it contacts anything. All of them need BOTH `get` and `list`.
- `put` (with `get`, to confirm the write) stores a newly issued credential. `del` is for `deleteHeldCredential` and for the deletes `pruneHeldCredentials` makes (so `pruneHeldCredentials` needs `get`, `list` and `del`).
- `skipPrefix: true` is required: without it the path is placed under the app's own prefix and the grant does not cover `v1/held/`.
- The space is the manifest's primary space. In the OpenCredentials screens that is the `credentials` space; other apps use their own (a test app might use `applications`). Pass the matching kv to the held functions: `tcw.kv` is the primary manifest space's kv, and `tcw.kvForSpace(spaceUri)` is the kv of another space.

Errors. A kv call the app session may not make (a typed 401 or 403 from the node) throws `CredentialError` with code `PERMISSION_DENIED`. The node answers 401 both for a missing capability and for a stale session, and the SDK cannot tell them apart, so the message names both (for a read: "This app can't read held credentials: the session may lack kv get and list on v1/held/ (skipPrefix), or may need to sign in again."; for a delete the same with kv del). It is not recoverable by retrying the same call: the app needs a different grant or a fresh sign-in. A real network failure stays `OFFLINE` (recoverable). `findHeldCredential` still reads a failed list that is not a permission failure as "not found", but a permission failure throws, because "not found" there would make the caller acquire a credential (and mail a code) that the app then cannot store. A write the app may not make after a successful issue is `VERIFIED_NOT_SAVED`, as for every unconfirmed write (the caller must know a credential exists unsaved); when kv refused the write or its read-back with 401 or 403 the error carries the fixed marker `error.details.state === "permission_denied"` and nothing else from the kv error; `acquireHeldCredential` reads the store first, so a missing `get`/`list` grant is reported before any request or mail, but a missing `put` is only found after the credential is issued.

### Checking the grant first, and deleting one record

Two more functions of `@tinycloud/web-sdk/credentials`, for an app that wants to ask for the storage grant before it reads anything, and to remove one stored credential:

```ts
import { probeHeldStoreAccess, deleteHeldCredential } from "@tinycloud/web-sdk/credentials";

await probeHeldStoreAccess({ kv: tcw.kv, ownerDid });          // resolves, or throws PERMISSION_DENIED / OFFLINE
const removed = await deleteHeldCredential({ kv: tcw.kv, ownerDid, recordId }); // true, false, or throws PERMISSION_DENIED
```

- **`probeHeldStoreAccess({ kv, ownerDid }): Promise<void>`** makes ONE `kv.list` of the account's `v1/held/` prefix and nothing else: it follows no cursor, reads no record, verifies nothing, and never writes or deletes. It resolves when the list is ok (an empty store, a store with entries, and a truncated page all resolve). A typed 401 or 403 from kv throws `CredentialError` `PERMISSION_DENIED` with the same text as the read functions ("This app can't read held credentials: the session may lack kv get and list on v1/held/ (skipPrefix), or may need to sign in again."); any other failure, or a kv that throws, is `OFFLINE` ("Held credentials could not be listed"). An owner that is not a mainnet `did:pkh:eip155:1` account throws `ACTIVE_SESSION_REQUIRED` before any kv call.
  - **The probe checks LIST access only.** A session that holds `list` but not `get` on `v1/held/` passes the probe and fails later, when a record is read. The permission text names both `get` and `list` because the usual missing grant lacks both.
  - It needs `kv list` on `v1/held/` (with `skipPrefix: true`) and nothing else.
- **`deleteHeldCredential({ kv, ownerDid, recordId }): Promise<boolean>`** deletes the one record key for that account and record id (a 43-character base64url digest, as returned in `HeldMatch.recordId`); a malformed id throws `DESCRIPTOR_INVALID` before any kv call. It returns `true` when kv deleted it and `false` for a failed delete that is not a permission failure. A delete the session may not make throws `PERMISSION_DENIED` ("This app can't delete held credentials: the session may lack kv del on v1/held/ (skipPrefix), or may need to sign in again."). It needs `kv del` on `v1/held/` (with `skipPrefix: true`). Copies of the credential outside this store stay valid until their own expiry.
- `pruneHeldCredentials` (the bulk housekeeping that deletes expired and superseded records) is not part of this entry.
