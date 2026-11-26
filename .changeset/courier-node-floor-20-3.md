---
"@tinycloud/courier": patch
---

`engines.node` is `>=20.3.0`. Courier uses `AbortSignal.any`, which Node added in 20.3.0, so it doesn't run on Node 20.0 to 20.2. npm warns when you install on an older Node, and with `engine-strict` the install fails.

Details: TC-4279
