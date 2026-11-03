---
"@tinycloud/sdk-core": minor
---

OpenKey authorization requests can say the user may change the session expiry. `TinyCloudAuthorizationRequestV1` gains an optional `expiryChangeable`, `diffImmutableSiweFields` gains an `allowExpirationChange` option that leaves only `expirationTime` out of the comparison (the default call still reports it), and the new `checkChangedExpiration` decides whether a changed signed expiry is acceptable. It refuses another changed immutable field, a missing or repeated `Expiration Time` line, an expiry within 60 seconds of now or not after `Issued At` / `Not Before`, an expiry past a given maximum, and an expiry more than 10 years away. It returns the refusal reason, or `null` to accept. `@openkey/sdk` >= 0.13.0 (beta: 0.13.0-beta.0) forwards `expiryChangeable`; 0.12.x ignores it.

`checkChangedExpiration` also refuses a non-finite `now` or `maxExpiresAt`, refuses a signed `Expiration Time` line that is not in canonical form (CR or CRLF, a separator other than one space, trailing characters, or after `Resources:`), and names the latest allowed time when it refuses for `maxExpiresAt`. Call it only after the message was parsed and its signature verified with `SiweMessage`.

Details: TC-2276

Update: the 10-year limit was removed in a later change; the only upper limits are year 9999 for a signed message and 2255 for a delegation signed by the session key.
