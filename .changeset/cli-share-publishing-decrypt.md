---
"@tinycloud/cli": patch
---

`tc enable share` and `tc auth login --device --manifest builtin:share-publishing` now include the account's `tinycloud.encryption/decrypt` permission in the device approval request. This is the only encryption or secrets permission accepted with `--device`; other manifests that request encryption or secrets are refused with `DEVICE_AUTH_UNSUPPORTED_SCOPE` and should use another approval method. Details: TC-1778
