---
"@tinycloud/cli": patch
"@tinycloud/node-sdk": patch
---

OpenKey sign-in accepts the encryption action IDs and permissions OpenKey returns for `urn:tinycloud:encryption:` resources (`space` `encryption`, `path` the full resource URN), so `tc auth login --method openkey --keys <folder>` completes. Each ID and permission must still match a capability in the signed ReCap.

Details: TC-2034
