---
"@tinycloud/node-sdk": patch
"@tinycloud/sdk-core": patch
"@tinycloud/web-sdk": patch
---

Check whether the manifest account registry space already exists before hosting it during sign-in, and add implicit space-level `tinycloud.capabilities/read` grants for every space touched by a manifest request.
