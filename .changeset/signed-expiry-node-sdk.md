---
"@tinycloud/node-sdk": minor
---

`signInWithOpenKey` and `prepareOpenKeySignIn` accept `expiryChangeable: true`, which is sent to OpenKey and lets the user change the session expiry in the approval. For a request sent with it, `NodeUserAuthorization` accepts a different signed `Expiration Time` and builds the session, the persisted record and the delegations from the SIGNED expiry. The expiry must pass `checkChangedExpiration` (more than 60 seconds away, after `Issued At`, no more than 10 years out) and every other immutable field must still match; a refusal reads `OpenKey signedMessage <reason>`. Without the option nothing changes: an expiry difference still throws `OpenKey signedMessage altered immutable SIWE fields: expirationTime`. `TinyCloudNode.prepareOpenKeySignIn` now takes the same options. The registry root delegation and the sharing service now carry the expiry of the signed SIWE instead of `now + sessionExpirationMs`, so a session signed for a different lifetime no longer misreports its own expiry. `wireOpenKeyAuthorize` forwards the flag only when it is true.

Details: TC-2276
