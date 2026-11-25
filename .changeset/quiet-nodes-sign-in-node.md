---
"@tinycloud/sdk-core": patch
"@tinycloud/node-sdk": patch
---

Successful sign-in results identify the secret key resources omitted when the node does not advertise `encryption-named-keys-v1`. Node sign-in methods still resolve to `undefined` when there is no warning; their return type is `Promise<SignInResult | void>`, so explicit `Promise<void>` annotations on the result need updating.

Details: TC-3975
