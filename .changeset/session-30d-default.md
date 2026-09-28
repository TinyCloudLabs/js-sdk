---
"@tinycloud/sdk-core": patch
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
---

Raise the default sign-in session lifetime (`EXPIRY.SESSION_MS`) from 7 days to 30 days. `TinyCloudNode`, `NodeUserAuthorization`, `TinyCloudWeb`, and the `delegateTo` default expiry inherit the new value when `sessionExpirationMs` / `expiry` is not set. Long-running backend services and agents now re-sign in less often; revocation remains the control for ending a session early, and delegations minted from a session stay bounded by the session's expiry. Share-link (`EXPIRY.SHARE_MS`, 7 days), app manifest, ephemeral, and signed-read-URL defaults are unchanged.
