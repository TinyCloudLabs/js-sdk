---
"@tinycloud/web-sdk": patch
---

`requestPermissions` on an OpenKey session now names the key it asks OpenKey to sign with. Every OpenKey sign request for a runtime grant carries the `keyId` of the connected account, and a client that is not connected is connected first (`connect()`, in the configured `mode`), so a restored session no longer opens a sign dialog that has no key. The signed message and the requested permissions are unchanged. This replaces the earlier refusal for a never-connected client: it now connects instead of falling back to the node's wallet signer.

When no single key can be named, `requestPermissions` rejects with the new exported `OpenKeySigningKeyError` before any sign request: `code` `OPENKEY_KEY_MISSING` (the client is not connected and cannot connect, or `connect()` returned no `keyId`) or `OPENKEY_KEY_AMBIGUOUS` (the connected key is not the signed-in account's, or reports no address). The SDK never calls the client's `signMessage` without a `keyId`. A signer set with `setRuntimePermissionSigner` still takes precedence.

Details: TC-2281
