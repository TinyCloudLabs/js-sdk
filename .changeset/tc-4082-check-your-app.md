---
"@tinycloud/web-sdk": patch
---

To check whether your app is affected by `ACCOUNT_SETUP_REQUIRED` on web-sdk 3.12.0 or 3.13.0, search your app's built JavaScript for `requireExistingAccount:!`. If you find it, look at the `FIRST_PARTY_ORIGINS` list beside it. If your app's own origin is not in that list, owners who have no registry record cannot sign in to your app. Your app's manifest and abilities make no difference. Upgrade to 3.16.0: owners whose account is hosted on the default node can then sign in, as long as your app asks only for its own `applications` space.

Details: TC-4082
