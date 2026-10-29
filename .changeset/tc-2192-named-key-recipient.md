---
"@tinycloud/share-sdk": patch
---

Support named-key v2 recipient content with optional AAD, checking canonical wrapped-key hashes independently from registered decoded-byte digests and enforcing source bindings before decrypt requests. Validate ciphertext framing before requesting decryption and retain AAD when re-encrypting content.

Details: TC-2192
