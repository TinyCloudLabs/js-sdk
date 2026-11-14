---
"@tinycloud/bootstrap": patch
"@tinycloud/sdk-core": patch
"@tinycloud/web-sdk": patch
---

Treat `https://tinycloud.one` as a first-party origin. Pages served from that exact origin receive the implicit first-party bootstrap permissions at sign-in, like the other first-party app origins. Subdomains, other ports, `http://` and other casings are still treated as third-party.

Details: TC-3030
