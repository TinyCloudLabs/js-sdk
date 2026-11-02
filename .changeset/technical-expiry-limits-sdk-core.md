---
"@tinycloud/sdk-core": minor
---

The 10-year ceiling on lifetimes is gone. `EXPIRY.MAX_MS` is removed from the `EXPIRY` export (breaking for any code that read it; nothing in this repository or the other TinyCloud repositories did). In its place the SDK knows the two limits that are technical, with dates:

- `MAX_SIWE_EXPIRY_MS` (9999-12-31T23:59:59Z): the latest expiry a wallet-signed sign-in message can carry, because it writes times with a four-digit year. This covers sessions, owner delegations and an expiry the user changes in OpenKey.
- `MAX_UCAN_EXPIRY_MS` (2255-06-05T23:47:34Z): the latest expiry a token signed by the session key can carry (`delegateTo`, agent and share delegations), because the WASM builder stops there. A session itself can still be signed to 9999.

`technicalExpiryRefusal(expiresAt, "siwe" | "ucan")` returns a plain, dated reason (or `null`) and `assertExpiryWithinTechnicalLimit` throws it. Both also refuse an invalid Date, `NaN` and `Infinity`, which would otherwise surface as `RangeError: Invalid time value`.

`checkChangedExpiration` (the OpenKey changed-expiry check) now refuses an expiry later than 9999-12-31 with `expiry is later than 9999-12-31, the latest date a TinyCloud sign-in message can carry; choose an earlier expiry` instead of `more than 10 years away`. Every other rule is unchanged: a valid timestamp, more than 60 seconds from now, after `Issued At` and `Not Before`, and not after `maxExpiresAt`.

Details: TC-2272
