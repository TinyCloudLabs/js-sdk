---
"@tinycloud/web-sdk": minor
---

`openkey.expiryChangeable` is a new TinyCloudWeb option. When true, the OpenKey request tells OpenKey the user may change the session expiry, and the session is built with the expiry the user signed. It is a pass-through: `@openkey/sdk` >= 0.13.0 (beta: 0.13.0-beta.0) forwards it and the option is inert on 0.12.x, so nothing changes until the app also updates `@openkey/sdk`.

`openkey.maxExpiresAt` (epoch milliseconds, a `Date`, or a function read when the approval comes back) sets the latest expiry the app accepts; a later signed expiry is refused before the session is built or stored, and the value is never sent to OpenKey.

Details: TC-2276
