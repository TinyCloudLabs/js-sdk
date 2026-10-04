---
"@tinycloud/web-sdk": minor
---

Share reads now preserve the Node's HTTP status and response text in errors. A cached recipient session is re-admitted only after a typed 401/403 (or a legacy untyped error ending in `(401)` or `(403)`); a typed non-auth error keeps the session even if its body mentions authorization.
