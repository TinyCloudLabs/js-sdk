---
"@tinycloud/web-sdk": minor
---

`openkey.expiryChangeable` is a new TinyCloudWeb option. When true, the OpenKey request tells OpenKey the user may change the session expiry, and the session is built with the expiry the user signed. It is a pass-through: `@openkey/sdk` >= 0.13.0 (beta) forwards it (version TBD until released) and 0.12.x ignores it, so nothing changes until the app also updates `@openkey/sdk`.

Details: TC-2276
