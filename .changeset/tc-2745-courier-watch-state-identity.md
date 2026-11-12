---
"@tinycloud/courier": minor
---

Each authenticated Courier agent now has its own hosted watcher state, so agents under the same owner run their watchers independently. The same agent still shares state, with conflict protection, across homes. Existing shared state is kept and isn't adopted automatically. Library callers that construct `Watcher` must now pass the authenticated `courierDid`.

Details: TC-2745
