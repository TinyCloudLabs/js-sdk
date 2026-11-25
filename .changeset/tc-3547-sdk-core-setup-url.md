---
"@tinycloud/sdk-core": minor
---

`AccountSetupRequiredError`'s default message names TinyCloud One and ends with the error's `setupUrl`, the address where the person finishes setting up their account.

`setupUrl` is `https://tinycloud.one/?finish-setup=registry`, so TinyCloud One opens its finish-setup step.

Upgrading: an app that matches the message text or compares `setupUrl` with a fixed address should check `instanceof AccountSetupRequiredError` and send the person to `setupUrl` as given.

`signLocationRecordV2` accepts a wallet signature whose recovery byte is 0 or 1, as some hardware wallets return, and records it as 27 or 28.

Details: TC-3547
