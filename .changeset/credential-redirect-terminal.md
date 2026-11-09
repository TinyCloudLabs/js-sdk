---
"@tinycloud/web-sdk": patch
"@tinycloud/node-sdk": patch
---

A credential redirect request that the issuer reports as expired, canceled or out of proof attempts is removed from storage, so the next sign-in starts fresh. A bare 410 from the issuer is reported as an expired request.

Details: TC-2607
