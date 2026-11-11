---
"@tinycloud/node-sdk": minor
---

Adds `TinyCloudNode.checkSpaceHosting(space?)`, which asks the node whether a space is hosted and answers `"hosted"`, `"not-hosted"` or `"unknown"`. It takes a space name or a full space id and defaults to the primary space. It sends one authorized read the session already holds on that space (a kv list under a granted prefix, else kv metadata, `tinycloud.space/info` or a kv get of a key that does not exist), signed for that space. A session with no such read sends nothing and answers `"unknown"`. A 401 or 403 registers the session delegation once and asks again once; a network failure, a 5xx or a 5 second timeout answers `"unknown"`. `"hosted"` is remembered for the session and `"not-hosted"` never is.

Adds the `TinyCloudNode.spaceHosting` getter, the last answer for the primary space, and the `SpaceHosting` type. Sign-in records it from the node's activation of the new session: a skipped primary space is `"not-hosted"`, an activated one is `"hosted"`, and when both lists are empty the SDK asks with `checkSpaceHosting()`. A dismissed or timed-out space creation records `"not-hosted"` (a dismissed one still resolves `signIn()`; a timeout still throws).

`NodeUserAuthorization.ensureSpaceExists()` is split into the activation step and `ensurePrimarySpaceHosted(hosting)`, which creates the space only when given `"not-hosted"`. An empty activation list is never read as "hosted". `TinyCloudNode.restoreSession()` still makes no network request.

Details: TC-2380
