---
"@tinycloud/sdk-services": minor
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": minor
"@tinycloud/web-sdk": minor
"@tinycloud/operations": minor
"@tinycloud/cli": minor
---

Secret Manager now gives each new secret you add in the app its own encryption key. When you let someone read secrets like these, you name exactly which ones they can read. Secrets you added before this keep working as they are.

Details: TC-3284
