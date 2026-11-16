---
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": minor
"@tinycloud/web-sdk": minor
"@tinycloud/share-sdk": minor
---

Add opt-in wallet-owner-signed placement for native sharing envelopes. Receivers verify the share, space, destination and validity without publishing a registry entry; verified registry placement remains authoritative. Version-2 envelopes need an updated receiver. Managed OpenKey placement approval remains a separate integration.

Details: TC-2937
