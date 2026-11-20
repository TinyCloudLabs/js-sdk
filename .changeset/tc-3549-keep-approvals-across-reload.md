---
"@tinycloud/web-sdk": minor
---

Permissions an app asks for while it's open stay approved after the page reloads, for as long as each approval lasts. Each app keeps only what was approved for that app; another app asking for the same access gets its own request. Only approvals for key-value, SQL and file access in one space are kept; the app asks again for any other approval after a reload. Requests that decrypt data, create keys, touch the secrets space, carry conditions or use a service other than key-value, SQL, files or delegation don't offer "Don't ask again for 30 days"; each one is approved on OpenKey's screen. Sign-in permissions are unchanged.

`hasPermissions(entries)` reports whether current approvals cover the given entries. With `{ onBehalfOf: appId }`, it counts only the session's sign-in permissions and approvals given for that app. `permissionsReady()` resolves once approvals kept before a reload are active again, or after 4 seconds at most; it never rejects, and an approval still being restored by then counts as not held.

Details: TC-3549
