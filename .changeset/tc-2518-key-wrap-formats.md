---
"@tinycloud/sdk-services": minor
"@tinycloud/node-sdk": minor
"@tinycloud/web-sdk": minor
---

Add opt-in TCW2 key wraps with HKDF-SHA256, authenticated key context and metadata, and support for reading both wrap versions independently of the configured writer. New writes remain v1 unless `keyWrapV2` is enabled. Network descriptors and payload schemas are unchanged.

Add the default-off `requireKeyWrapV2` reader policy across Node, Web, services, and named-key clients without changing writer defaults or signed receiver-response compatibility. Reject lone UTF-16 surrogates in authenticated context strings and reroll reserved-prefix v1 ephemeral keys without changing the v1 format.

Column decryption now requires an explicit expected format. V1 wrapped keys require encrypted framing; callers selecting legacy plaintext preserve all bytes unless `strictEncryption` is enabled. Both flags default to false.

Details: TC-2518, TC-2517
