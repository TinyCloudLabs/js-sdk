---
"@tinycloud/sdk-core": patch
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
---

Space-hosting delegations carry an explicit expiration one UTC calendar year after creation, with February 29 clamped to February 28. A caller's `siweConfig.expirationTime` may shorten that lifetime; later values are clamped to the hosting tier. Node and browser SDKs apply the expiration before signing.

Details: TC-2691
