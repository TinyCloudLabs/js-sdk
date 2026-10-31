---
"@tinycloud/sdk-core": minor
---

OpenKey authorization requests can say the user may change the session expiry. `TinyCloudAuthorizationRequestV1` gains an optional `expiryChangeable`, `diffImmutableSiweFields` gains an `allowExpirationChange` option that leaves only `expirationTime` out of the comparison (the default call still reports it), and the new `checkChangedExpiration` decides whether a changed signed expiry is acceptable. It refuses another changed immutable field, a missing or repeated `Expiration Time` line, an expiry within 60 seconds of now or not after `Issued At` / `Not Before`, an expiry past a given maximum, and an expiry more than 10 years away. It returns the refusal reason, or `null` to accept. `@openkey/sdk` >= 0.13.0 (beta) forwards `expiryChangeable`; version TBD until released.

Details: TC-2276
