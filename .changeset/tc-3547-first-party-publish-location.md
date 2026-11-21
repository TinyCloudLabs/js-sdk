---
"@tinycloud/web-sdk": minor
"@tinycloud/sdk-core": minor
---

First-party sign-in (home.tinycloud.xyz, tinycloud.one, the SDK's first-party WebView origins) now publishes the owner's registry location record once per fresh account, so a third-party app's next sign-in no longer refuses the account as "unregistered". Publishing is opt-in: the host app supplies an `onRegistryPublishConsent(preview)` callback and an optional `onRegistryPublishError`; without the callback the publish short-circuits as declined and sign-in proceeds unchanged. The record always lists the SDK's verified active node (never a caller-supplied node) for the owner's primary space; the automatic path publishes only when the registry verdict is `unregistered` and never overwrites an existing record. Declined publishes persist in the account-registry KV at `system/registry-publish/dismissed/v1`, so a "finish setup" banner stays dismissed. Sign-in itself never fails on publish errors, and logs never carry the signature or the full record.

`AccountSetupRequiredError` carries a new `setupInstruction` field; the default matches the previous human message exactly, so host apps that already render `error.message` see no change. Hosts can construct the error with custom copy (e.g. "Finish setup at Home so {app} can see your spaces"), which is what the outside-app wall uses to carry one labelled link back to Home.

Details: TC-3547.
