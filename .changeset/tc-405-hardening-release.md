---
"@tinycloud/share-envelope": patch
"@tinycloud/share-sdk": patch
"@tinycloud/node-sdk": patch
---

Publish the TC-405 v3 delegation envelope and SDK together under fresh beta
versions so consumers cannot resolve the stale `share-envelope@0.2.0-beta.0`
artifact that predates the v3 APIs. Derive installed runtime-delegation
provenance from signed UCAN authority and accept the node's canonical padded
Base64 decrypt-response fields.
