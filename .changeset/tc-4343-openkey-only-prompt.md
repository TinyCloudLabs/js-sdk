---
"@tinycloud/web-sdk": patch
---

When OpenKey signs, `requestPermissions` skips the SDK's own "requesting additional permissions" prompt, and OpenKey's approval screen is the only one. This covers older OpenKey clients. A key that signs in an external wallet gets no OpenKey screen, so the SDK prompt shows, with the name of the app the request is made for. OpenKey used as a plain injected wallet, without `openkey` configured, shows the SDK prompt.

Details: TC-4343
