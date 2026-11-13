---
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
---

Encryption-network calls for the production node (network descriptors, decrypt, network create and revoke, and named keys) now always use `https://tee.node.tinycloud.xyz`, the origin whose TLS terminates inside the node's TEE, even when the session's host is `https://node.tinycloud.xyz`. They never fall back to the other name, and named-key requests refuse redirects. Other hosts, including self-hosted and local nodes, are unchanged. `@tinycloud/sdk-core` exports `endToEndNodeHost()` for this mapping.

Details: TC-2923
