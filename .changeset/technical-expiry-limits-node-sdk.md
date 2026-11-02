---
"@tinycloud/node-sdk": patch
---

`createOwnerDelegation` no longer refuses an expiry more than 10 years away: any future date up to 9999-12-31T23:59:59Z is accepted. The same limit now guards every other place the SDK writes a wallet-signed expiry (the session lifetime from `sessionExpirationMs`, runtime grants, wallet-signed delegations, `createSubDelegation`, activating a received delegation, and the `expiresAt` of `authorizeShareDeliveryV3`).

A token signed by the session key (`delegateTo`, agent and share delegations) is refused past 2255-06-05T23:47:34Z, in `NodeWasmBindings.createDelegation`, before the WASM is called. The limit is exported as `MAX_UCAN_EXPIRY_MS`, with `ucanExpiryRefusal` and `assertUcanExpiryWithinLimit`. It is node-only: the browser bundle does not carry it.

A value past a limit, or a lifetime no date can hold (such as `ms("99999999y")`), is refused with a message that names the date and the cause, before the wallet is asked to sign and before the WASM is called. It no longer surfaces as `RangeError: Invalid time value`, `the 'year' component could not be parsed` or `Out of valid microsecond-precision range of NumericDate`.

Details: TC-2272
