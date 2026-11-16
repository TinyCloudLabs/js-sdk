---
"@tinycloud/bootstrap": patch
"@tinycloud/sdk-core": patch
"@tinycloud/web-sdk": patch
---

Treat `https://tinycloud.one` and two native webview origins, `https://app.tinycloud.one` and `tinycloudone://app.tinycloud.one`, as first-party origins. Pages served from those exact origins receive the implicit first-party bootstrap permissions at sign-in, like the other first-party app origins. Subdomains, other ports, `http://`, other schemes and other casings are still treated as third-party.

Details: TC-3030
