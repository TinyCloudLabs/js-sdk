---
"@tinycloud/cli": patch
---

`tinycloud auth login --device` no longer refuses a manifest that asks for decrypt on your own `default` network (`tinycloud.encryption/decrypt`, space `default`, empty path). The CLI sends that entry to OpenKey as written, and OpenKey decides. Every other encryption entry and the `secrets` space are still refused with `DEVICE_AUTH_UNSUPPORTED_SCOPE`.

Details: TC-2534
