---
"@tinycloud/sdk-core": patch
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
---

Set space-hosting delegations to expire after one UTC calendar year, with leap-day clamping. Preserve shorter caller expirations and clamp later values to the hosting tier before signing in the Node and browser SDKs.

Details: TC-2691
