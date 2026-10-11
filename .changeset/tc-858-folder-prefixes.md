---
"@tinycloud/replica": minor
"@tinycloud/cli": patch
"@tinycloud/node-sdk": patch
"@tinycloud/sdk-services": patch
---

Replication prefixes now name folders (`notes/`) or the root (`""`). Bare replica prefixes are now rejected; use `notes/`.

CLI and node-sdk validate folder prefixes and use sdk-core capability containment as the only grant coverage rule. sdk-services now serves local LIST only when the folder prefix contains its requested path.
