---
"@tinycloud/node-sdk": minor
"@tinycloud/sdk-core": patch
---

Include `siweConfig.resources` recipients-declaration URIs in ordinary, external/OpenKey and bootstrap SIWE preparation. This option accepts `urn:tinycloud:recipients:<base64url>` with an unpadded base64url payload. The original ReCap stays last and unchanged, and completion retains the exact signed message. An absent or empty resource list leaves preparation unchanged.

Align shared ReCap extraction with complete resource values in the SIWE resources section.

Details: TC-2230
