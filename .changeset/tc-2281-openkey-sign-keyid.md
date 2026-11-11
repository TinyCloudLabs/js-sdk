---
"@tinycloud/web-sdk": minor
---

`requestPermissions` on an OpenKey session now names the key it asks OpenKey to sign with. Every OpenKey sign request for a runtime grant carries the `keyId` of the connected account, and a client that is not connected is connected first (`connect()`, in the configured `mode`), so a restored session no longer opens a sign dialog that has no key. The signed message and the requested permissions are unchanged. This replaces the earlier refusal for a never-connected client: it now connects instead of falling back to the node's wallet signer.

In popup mode (the default) a browser blocks a second popup opened after the user spent time in the connect popup, so the first Allow only connects: `requestPermissions` rejects with `OpenKeySigningKeyError` code `OPENKEY_CONNECTED_RETRY`, nothing is signed, and the second click signs with the connected key in one popup. Show your Allow button again on that code. `iframe` and `redirect` mode connect and sign in one click.

New exported `OpenKeySigningKeyError` (with `OpenKeySigningKeyErrorCode`), thrown before any sign request: `OPENKEY_KEY_MISSING` (the client is not connected and cannot connect, or `connect()` returned no `keyId`), `OPENKEY_KEY_AMBIGUOUS` (the connected key is not the signed-in account's, or reports no address) and `OPENKEY_CONNECTED_RETRY`. The SDK never calls the client's `signMessage` without a `keyId`. If the session ends or changes while a connect or sign dialog is open, the grant is cancelled and the signature is not used. A signer set with `setRuntimePermissionSigner` still takes precedence.

Details: TC-2281
