---
"@tinycloud/web-sdk": patch
---

When OpenKey signs, `requestPermissions` never shows the SDK's own "requesting additional permissions" prompt; OpenKey's approval screen is the only one. This covers older OpenKey clients and keys that sign in an external wallet, whose signing screen may show only the raw sign-in message. OpenKey used as a plain injected wallet, without `openkey` configured, shows the SDK prompt.

Details: TC-4343
