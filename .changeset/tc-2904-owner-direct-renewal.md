---
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": patch
---

Expose verified SIWE ReCap proof CIDs and admit an already-signed owner renewal lease for an exact agent delegation through the lazy renewal subpath, without an agent private key. Ambiguous or malformed ReCap proof data is now refused.

Return distinct renewal expiry/inactive error codes so clients can distinguish refusal from unavailable status.

Details: TC-2904
