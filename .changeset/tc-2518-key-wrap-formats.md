---
"@tinycloud/sdk-services": minor
"@tinycloud/node-sdk": minor
"@tinycloud/web-sdk": minor
---

Add opt-in TCW2 key wraps (HKDF-SHA256, with authenticated key context and metadata). Readers accept both wrap versions whatever the writer is set to; new writes stay v1 unless `keyWrapV2` is enabled. Network descriptors and payload schemas are unchanged.

Add the `requireKeyWrapV2` reader policy (off by default) across Node, Web, services and named-key clients. Writer defaults and signed receiver-response compatibility are unchanged.

Column decryption now requires an explicit expected format. V1 wrapped keys require encrypted framing; callers that select legacy plaintext get the bytes unchanged unless `strictEncryption` is enabled. Both flags default to false.

Details: TC-2518, TC-2517
