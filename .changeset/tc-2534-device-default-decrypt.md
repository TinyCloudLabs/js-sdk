---
"@tinycloud/cli": patch
---

`tinycloud auth login --device` no longer refuses a manifest that asks for decrypt on your own `default` network (`tinycloud.encryption/decrypt`, space `default`, empty path). The CLI sends that entry to OpenKey as written, and OpenKey decides. Every other encryption entry and the `secrets` space are still refused with `DEVICE_AUTH_UNSUPPORTED_SCOPE`, whose message now reads "--device can't authorize the secrets space, or tinycloud.encryption beyond decrypt on the default network."

Details: TC-2534
