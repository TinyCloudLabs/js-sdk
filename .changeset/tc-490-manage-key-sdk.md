---
"@tinycloud/sdk-core": minor
"@tinycloud/web-sdk": minor
---

Add the OAuth `tinycloud:manage-key` canonical-key signer and the public web
SDK session helper. The signer preserves the exact SIWE/ReCap bytes, uses a
cookie-free client token only, validates the canonical identity and signature,
and exposes terminal OAuth policy errors.
