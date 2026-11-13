---
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
---

Expose verified SIWE ReCap proof CIDs and admit an already-signed owner renewal lease for an exact agent delegation through the lazy renewal subpath, without an agent private key. Ambiguous or malformed ReCap proof data is now refused.

Return distinct renewal expiry/inactive error codes so clients can distinguish refusal from unavailable status.

Keep renewal signature recovery inside its existing lazy web bundle so downstream bundlers do not scan declaration files as runtime modules.

Details: TC-2904
