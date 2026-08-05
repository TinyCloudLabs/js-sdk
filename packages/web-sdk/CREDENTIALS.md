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

`interaction: "inline"` requires a host-owned `InlineCredentialInteraction`. The SDK gives that adapter only an abort signal and declared proof-step metadata. The host returns locally entered proof values; the SDK alone sends them to OpenCredentials, performs holder signing, verifies the issued credential, and writes the holder-owned record. In particular, an inline host never receives an acquisition locator, completion verifier, transport function, TinyCloud session, or signing capability. Do not log or forward the proof value returned by `requestProof`.

The host owns the accessible form: use a programmatic label for every field, move focus to the heading or alert on state changes, keep the primary action reachable by keyboard, expose busy/error status with a live region, and keep controls usable at narrow viewport widths. `requestProof` may reject with `CredentialError("CANCELED", ...)` when the holder cancels; a recoverable credential error may be rendered with an explicit retry action that calls `ensure` again.

An inline surface is recreated for a resumed request so the current signed-in holder sees the same local UI after an interruption. The default inline path persists nothing. If a host explicitly supplies a redirect store, its request continuation is still bound to the active holder, descriptor, requirement, and origin; the host must supply the inline adapter again when calling `ensure` to resume it.

Failures are `CredentialError` values with stable `code` and `recoverable` fields. Issuance followed by an unconfirmed write is always `VERIFIED_NOT_SAVED`, never success. A blocked popup can be retried with `interaction: "redirect"` without changing holder or storage authority. Redirect mode keeps only its request-specific verifier and bindings in same-origin session storage; it never persists the TinyCloud session. Calling the same `ensure` operation after the host session is restored resumes that exact request, and mismatched holder, requirement, or descriptor state fails closed.
