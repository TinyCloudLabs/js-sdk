---
"@tinycloud/sdk-services": patch
"@tinycloud/sdk-core": patch
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
"@tinycloud/operations": patch
"@tinycloud/cli": patch
---

If you remove a secret that has its own encryption key and add it again, it now gets a new key, and read grants for the old one can't read it. Changing a secret's value keeps its read grants.

Details: TC-3284
