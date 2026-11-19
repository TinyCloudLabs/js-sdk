---
"@tinycloud/cli": patch
---

`--device` refuses encryption permissions and the secrets space before it starts a request (`DEVICE_AUTH_UNSUPPORTED_SCOPE`, exit 2).

Details: TC-3391
