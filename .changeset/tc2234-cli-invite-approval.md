---
"@tinycloud/cli": minor
---

**Not available yet.** The CLI includes the code to share a file to an email address from a session-only sign-in by asking the owner for one approval per invitation, but this release can't reach it: `share publish --to email:` is refused ("email-addressed shares are not available in this release"), and OpenKey does not handle invitation approvals yet. The design: the request shows the recipient, the file name and the dates; OpenKey chooses the Share key and returns a grant for that one key (`key.create` and `decrypt`), valid for at most 24 hours. The CLI checks that the owner-signed grant answers this request and holds exactly that one pair for the profile's own account, takes it once, and installs it as a runtime grant on the profile's node to encrypt the file under that key; it never creates a key and does not change the profile's session. A file that would stay readable longer than 31 days (the existing policy root limit) is refused before the owner is asked. Sign-ins that already hold decrypt, and local-key profiles, are unchanged.

Details: TC-2234
