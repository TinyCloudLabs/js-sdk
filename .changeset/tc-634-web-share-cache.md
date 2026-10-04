---
"@tinycloud/web-sdk": minor
---

Share reads preserve the Node's HTTP status and bounded diagnostic text, even when reading the response body fails. A cached recipient session is re-admitted only after a typed 401/403 (or a legacy untyped error ending in `(401)` or `(403)`); a typed non-auth error retains the session even if its body mentions authorization.
