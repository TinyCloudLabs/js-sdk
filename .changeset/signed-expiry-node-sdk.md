---
"@tinycloud/node-sdk": minor
---

`signInWithOpenKey` and `prepareOpenKeySignIn` accept `expiryChangeable: true`, which is sent to OpenKey and lets the user change the session expiry in the approval. For a request sent with it, `NodeUserAuthorization` accepts a different signed `Expiration Time` and builds the session, the persisted record and the delegations from the SIGNED expiry. The expiry must pass `checkChangedExpiration` (more than 60 seconds away, after `Issued At`, no more than 10 years out) and every other immutable field must still match; a refusal reads `OpenKey signedMessage <reason>`. Without the option nothing changes: an expiry difference still throws `OpenKey signedMessage altered immutable SIWE fields: expirationTime`. `TinyCloudNode.prepareOpenKeySignIn` now takes the same options. The registry root delegations now carry the expiry of the signed SIWE instead of `now + sessionExpirationMs`, so a session signed for a different lifetime no longer misreports its own expiry. `wireOpenKeyAuthorize` forwards the flag only when it is true.

A new `maxExpiresAt` option (epoch milliseconds, a `Date`, or a function read when the result arrives) sets the latest signed expiry an app accepts. A signed expiry beyond it is refused before any session is built, stored or activated; it is never sent to OpenKey or persisted, and it limits a changed expiry only. The persisted `expiresAt` and `createdAt` of every sign-in now come from the `Expiration Time` and `Issued At` lines at the start of a line, so text inside a ReCap statement can no longer stand in for them.

Details: TC-2276

Update: the 10-year limit was removed in a later change; the only upper limits are year 9999 for a signed message and 2255 for a delegation signed by the session key.
