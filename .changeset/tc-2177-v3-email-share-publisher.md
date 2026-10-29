---
"@tinycloud/cli": patch
"@tinycloud/node-sdk": patch
"@tinycloud/sdk-core": patch
"@tinycloud/sdk-services": patch
"@tinycloud/share-envelope": patch
"@tinycloud/share-sdk": patch
---

Publish new CLI email shares as signed V3 Policy/v2 envelopes inside current v4 Share link records, with a unique exact `default/share/<shareId>` encryption key, a path-bound policy, and a committed email credential requirement. The `builtin:share-publishing` paste approval requests decrypt only for the owner's default-network `share/` prefix; device authorization and `enable share` omit decrypt. Existing V2 envelopes retain their read path.

Details: TC-2177
