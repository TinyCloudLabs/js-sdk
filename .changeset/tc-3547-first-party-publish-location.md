---
"@tinycloud/web-sdk": minor
---

`tcw.ensureOwnerRegistryRecord()` publishes the owner's registry location record from TinyCloud One, so the owner's next sign-in to a third-party app accepts the account. The host app calls it, for example from TinyCloud One's `?finish-setup=registry` link. It asks the owner to sign, in their wallet or OpenKey, only when the registry has no record for them. On any other host, or when OpenKey refuses to sign the record, an owner with no record gets `"needs-one"`. Send them to `AccountSetupRequiredError.setupUrl`, then have them sign in to the app again. The record lists the SDK's verified active node for the owner's primary space. It's published only when the registry has no record for the owner, and an existing record is never overwritten. `onRegistryPublishError` is notified of failures.

`AccountSetupRequiredError`'s default message names TinyCloud One and ends with the error's `setupUrl`, the address where the person finishes setting up their account.

`setupUrl` is now `https://tinycloud.one/?finish-setup=registry` (it was `https://tinycloud.one/`), so TinyCloud One opens its finish-setup step.

Upgrading: an app that matches the message text or compares `setupUrl` with a fixed address should check `instanceof AccountSetupRequiredError` instead, and send the person to `setupUrl` as given.

`signLocationRecordV2` accepts a wallet signature whose recovery byte is 0 or 1, as some hardware wallets return, and records it as 27 or 28.

Details: TC-3547
