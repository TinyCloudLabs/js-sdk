---
"@tinycloud/share-envelope": major
"@tinycloud/share-sdk": major
"@tinycloud/sdk-core": major
"@tinycloud/node-sdk": major
"@tinycloud/web-sdk": major
"@tinycloud/sdk-services": major
"@tinycloud/cli": major
---

Seal Policy/v3 recipient metadata as the canonical AES-256-GCM
`version || nonce || ciphertext+tag` blob before constructing an addressed
share link. Delivery authorization now binds that sealed blob and its
fragment-only key, rather than accepting a plaintext `?tc2` envelope. Remove
the public plaintext Policy/v3 inline URL codec; only sealed fragment links
are accepted for addressed shares.
