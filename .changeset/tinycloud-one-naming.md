---
"@tinycloud/cli": patch
"@tinycloud/sdk-core": patch
"@tinycloud/web-sdk": patch
---

User-facing text names the product TinyCloud One. `AccountSetupRequiredError` (and its `setupUrl`) now points at https://tinycloud.one/ instead of https://home.tinycloud.xyz/. The CLI README heading "Home feed" is now "TinyCloud One feed" (anchor `#tinycloud-one-feed`), and `tinycloud feed --help` and the README say "TinyCloud One" where they said "Home". The CLI auth skill's example says "a TinyCloud One agent's `applications` session". The web SDK README documents the new setup link.

Details: TC-3659
