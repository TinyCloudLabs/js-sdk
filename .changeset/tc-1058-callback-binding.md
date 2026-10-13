---
"@tinycloud/cli": patch
---

The browser login's local callback only accepts the delegation from OpenKey (TC-1058). It now listens on an unguessable `/callback/<random>` path and answers only OpenKey's origin, so other origins get 403. A malformed or foreign request is refused without ending the login; before, any request to `/callback` ended it.

When a login first pins a profile's owner, the CLI now prints that owner on stderr. Nothing yet binds the approval to one specific login attempt; that needs an OpenKey nonce. Until then, this line is how you spot a profile that someone else's account approved.
