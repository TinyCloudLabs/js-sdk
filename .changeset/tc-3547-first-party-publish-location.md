---
"@tinycloud/web-sdk": minor
"@tinycloud/sdk-core": minor
---

First-party sign-in (home.tinycloud.xyz, tinycloud.one and the SDK's first-party WebView origins) can publish the owner's registry location record once for a new account, so a third-party app's next sign-in accepts the account. The host app opts in with an `onRegistryPublishConsent(preview)` callback and, optionally, `onRegistryPublishError`. Without the callback nothing is published and sign-in goes ahead. The record lists the SDK's verified active node for the owner's primary space. It's published only when the registry has no record for the owner, and an existing record is never overwritten. A declined publish is remembered in this browser for this site (`localStorage`), so the finish-setup prompt stays dismissed there. `ensureOwnerRegistryRecord({ ignoreDismissed: true })` asks again, for a host that opens with `FINISH_SETUP_REGISTRY_INTENT` in its URL. Sign-in never fails because a publish failed.

`AccountSetupRequiredError`'s default message names TinyCloud One and ends with the error's `setupUrl`, the address where the person finishes setting up their account.

Upgrading: an app that matches the message text should check `instanceof AccountSetupRequiredError` or read `setupUrl` instead.

Details: TC-3547
