---
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
---

In the browser, the SIWE sign-in `domain` now uses `window.location.host` (it keeps the port) and, when the domain comes from the page, the SIWE `uri` defaults to `window.location.origin` (it keeps the scheme), so local http dev origins satisfy OpenKey's origin check (TC-1486). Production https origins on default ports are unchanged. `TinyCloudNodeConfig` gains an optional `uri`; a caller `siweConfig.uri` still takes precedence. (TC-1488)

Details: TC-1488
