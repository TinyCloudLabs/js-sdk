---
"@tinycloud/sdk-services": minor
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": minor
"@tinycloud/sdk-services-test": patch
---

TC-1372: add `kv.createSignedReadUrl()` for minting short-lived signed KV read URLs through tinycloud-node's `/signed/kv` endpoint.

The method signs a normal `tinycloud.kv/get` invocation for the resolved key path, posts the signed URL request to tinycloud-node, and returns an absolute URL plus the opaque ticket id and expiry metadata. Requires tinycloud-node with the TC-1368 signed KV URL API.

The default signed read URL expiry is exposed as `DEFAULT_SIGNED_READ_URL_EXPIRES_IN_SECONDS`.
