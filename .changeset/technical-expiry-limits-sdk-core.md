---
"@tinycloud/sdk-core": minor
---

The 10-year ceiling on lifetimes is gone. `EXPIRY.MAX_MS` is removed from the `EXPIRY` export (breaking for any code that read it; nothing in this repository or the other TinyCloud repositories did). In its place the SDK knows the one limit on a wallet-signed message, with its date: `MAX_SIWE_EXPIRY_MS` (9999-12-31T23:59:59Z), the latest expiry a sign-in message can carry because it writes times with a four-digit year. This covers sessions, owner delegations and an expiry the user changes in OpenKey.

`technicalExpiryRefusal(expiresAt)` returns a plain, dated reason (or `null`) and `assertExpiryWithinTechnicalLimit` throws it. Both also refuse an invalid Date, `NaN` and `Infinity`, which would otherwise surface as `RangeError: Invalid time value`. The matching limit for tokens signed by the session key (2255-06-05) is in `@tinycloud/node-sdk`.

`checkChangedExpiration` (the OpenKey changed-expiry check) now refuses an expiry later than 9999-12-31 with `expiry is later than 9999-12-31, the latest date a TinyCloud sign-in message can carry; choose an earlier expiry` instead of `more than 10 years away`. Every other rule is unchanged: a valid timestamp, more than 60 seconds from now, after `Issued At` and `Not Before`, and not after `maxExpiresAt`.

Details: TC-2272
