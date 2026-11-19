---
"@tinycloud/cli": patch
---

`auth import` of a delegation addressed to an agent (delegate-session) profile's own key now makes it the profile's session, replacing a live, expired or signed-out one, so `auth status` reports the new expiry and commands work until it passes. `auth logout` on such a profile with no local replica state clears the session but keeps the key, so a new grant can be imported for it; other logouts still delete the key. Logout output says which: `keyKept` and a `message` ("Signed out. The key is kept, so a new grant can be imported for it." or "Signed out. The key was deleted; the next sign-in creates a new one.").

Details: TC-3434
