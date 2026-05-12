---
"@tinycloud/web-sdk": minor
---

TC-1365: add browser session persistence/restoration for `TinyCloudWeb`.

The web SDK now uses `BrowserSessionStorage` by default, validates persisted
session data before writing it, reports restore status, rejects expired or
corrupt stored sessions, and attempts to restore a valid session in
`signIn()` before falling back to wallet login.
