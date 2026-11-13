---
"@tinycloud/sdk-core": minor
"@tinycloud/sdk-services": minor
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
"@tinycloud/share-sdk": patch
"@tinycloud/cli": patch
---

Encryption-network calls for the production node always use `https://tee.node.tinycloud.xyz`, the origin whose TLS terminates inside the node's TEE, even when the session's host is `https://node.tinycloud.xyz`. This covers network descriptors, decrypt, network create and revoke, named keys, sign-in activation of encryption resources, share network admin and recipient decrypt, and the CLI named-key preflight. These calls never fall back to the other name and refuse redirects. Other hosts, including self-hosted and local nodes, are unchanged. `@tinycloud/sdk-core` exports `endToEndNodeHost()` for this mapping.

Named-key clients created by `createNamedKeyClient(node)` resolve each network's registry route, and refuse a node whose `/info` identity differs from the verified one (`NODE_IDENTITY_MISMATCH`). `NamedKeyClientConfig` gains an optional `resolveNode`.

Network discovery consults the advisory well-known descriptor only when the node reports no network, and never for an owner with a registry record. A failed node lookup now returns `TRANSPORT_ERROR` instead of falling back to the advisory record.

Details: TC-2923
