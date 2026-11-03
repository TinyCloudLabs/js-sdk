---
"@tinycloud/web-sdk": minor
---

`TinyCloudWeb.restoreSession()` now makes one bounded node read before it reports `"restored"`: it asks the node whether the restored session's primary space is hosted, waiting at most 5 seconds. It never prompts and never fails or delays the restore past that cap; an answer it cannot get is `"unknown"`. Read the result from the new `TinyCloudWeb.spaceHosting` getter (`"hosted"`, `"not-hosted"` or `"unknown"`), or ask any time with `TinyCloudWeb.checkSpaceHosting(space?)`. `signIn()` on a restored session whose space is not hosted returns the restored session, as before. Exports the `SpaceHosting` type.

Details: TC-2380
