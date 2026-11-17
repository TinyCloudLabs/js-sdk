---
"@tinycloud/cli": patch
---

`--device` sign-in (`tc auth login --device`, `tc auth request --device`) can ask to decrypt only exact shared files: `tinycloud.encryption`, space `default`, path `share/<id>`, at most 4 per request. The CLI refuses any other encryption entry with `DEVICE_AUTH_UNSUPPORTED_SCOPE` before it contacts OpenKey, and the message names what `--device` allows. Browser and paste sign-in are unchanged.

Details: TC-3204
