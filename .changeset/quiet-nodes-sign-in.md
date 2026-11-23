---
"@tinycloud/sdk-core": patch
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
"@tinycloud/cli": patch
---

Successful sign-in results identify the secret key resources omitted when the node does not advertise `encryption-named-keys-v1`. Prepared CLI login displays the warning on stderr and includes the same structured `warnings` field in JSON output. Web sign-in preserves the existing session fields; Node sign-in methods now return a `SignInResult` instead of `void`, so explicit `Promise<void>` annotations need updating.

Details: TC-3975
