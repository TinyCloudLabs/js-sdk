---
"@tinycloud/sdk-core": patch
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
---

Space-hosting delegations now expire one year after they're created (UTC; February 29 becomes February 28). A shorter `siweConfig.expirationTime` is kept; a later one is reduced to one year. This applies in the Node and browser SDKs.

Details: TC-2691
