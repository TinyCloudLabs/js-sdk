---
"@tinycloud/web-sdk": minor
"@tinycloud/sdk-core": minor
---

`tcw.ensureOwnerRegistryRecord()` publishes the owner's registry location record from TinyCloud One or Home, so a third-party app's next sign-in accepts the account. It never runs on its own; the host calls it from a deliberate action such as a Finish setup button. On any other host, or when OpenKey refuses to sign the record, an owner with no record gets `"needs-one"`: send them to `AccountSetupRequiredError.setupUrl` and have them sign in to the app again. The record lists the SDK's verified active node for the owner's primary space. It's published only when the registry has no record for the owner, and an existing record is never overwritten. `onRegistryPublishError` is notified of failures.

`AccountSetupRequiredError`'s default message names TinyCloud One and ends with the error's `setupUrl`, the address where the person finishes setting up their account.

Upgrading: an app that matches the message text should check `instanceof AccountSetupRequiredError` or read `setupUrl` instead.

`signLocationRecordV2` accepts a wallet signature whose recovery byte is 0 or 1, as some hardware wallets return, and records it as 27 or 28.

Details: TC-3547
