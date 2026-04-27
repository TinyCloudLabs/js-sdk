---
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
---

Publish the UCAN delegation header fix from PR #192.

`createDelegationViaWasmPath` now activates session-key UCAN delegations with
the raw serialized JWT in the `Authorization` header instead of prefixing it
with `Bearer `. The TinyCloud host decodes this header directly as a UCAN JWT;
the prefixed value causes host activation to fail with 401 during
manifest-driven `delegateTo` flows such as TinyBoilerplate/OpenKey sign-in.
