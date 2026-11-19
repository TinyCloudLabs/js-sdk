---
"@tinycloud/cli": patch
---

`tinycloud auth login --device --manifest <file>` accepts a manifest that asks for named secrets: get, put or list on each secret it names. A manifest that asks for the whole secrets space, for deleting a secret or for any encryption permission other than decrypt on the default network still needs browser or `--paste` login.

Details: TC-3480
