---
"@tinycloud/cli": minor
---

Sharing a file to an email address from a session-only sign-in now asks the owner for one approval for that invitation instead of being refused. The request shows the recipient, the file name and the dates; OpenKey chooses the Share key and returns a grant for that one key (`key.create` and `decrypt`), valid for at most 24 hours. The CLI checks that the owner-signed grant answers this request and holds exactly that one pair for the profile's own account, takes it once, and installs it as a runtime grant on the profile's node to encrypt the file under that key; it never creates a key and does not change the profile's session. Running the same share again while the approval is open continues the same request and keeps its original expiry date. A file that would stay readable longer than 31 days (the existing policy root limit) is refused before the owner is asked, and the expiry is never shortened. Sign-ins that already hold decrypt, and local-key profiles, are unchanged.

Details: TC-2234
