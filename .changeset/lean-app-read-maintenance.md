---
"@tinycloud/sdk-core": patch
"@tinycloud/node-sdk": patch
"@tinycloud/operations": patch
"@tinycloud/cli": minor
---

Support canonical application discovery and one paste approval for exact registry and selected application reads. Verify the API protocol, signed scope, selected owner, local key and current application registration before persistence; append verified additional authority while preserving primary profile state. Reverify stored signed grants on fresh processes and retain the requested target space for multi-space delegated invocations.
