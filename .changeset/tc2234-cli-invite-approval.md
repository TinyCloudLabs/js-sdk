---
"@tinycloud/cli": minor
---

Sharing a file to an email address from a session-only sign-in now asks the owner for one approval for that invitation instead of being refused. The request shows the recipient, the file name and the dates; OpenKey chooses the Share key and returns a grant for that one key (`key.create` and `decrypt`), valid for at most 24 hours. The CLI checks the signed grant, takes it once, and uses it only to create the key and encrypt the file; it does not change the profile's session. Running the same share again while the approval is open continues the same request. Sign-ins that already hold decrypt, and local-key profiles, are unchanged.

Details: TC-2234
