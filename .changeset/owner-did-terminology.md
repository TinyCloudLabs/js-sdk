---
"@tinycloud/cli": minor
"@tinycloud/node-sdk": minor
"@tinycloud/sdk-core": minor
"@tinycloud/sdk-services": minor
---

Rename owner/delegate identity surfaces from primary/principal terminology to owner terminology.

CLI profiles and auth request artifacts now use `ownerDid` and `sessionDid`. Encryption network descriptors and discovery APIs now expose the owner identity as `ownerDid`.
