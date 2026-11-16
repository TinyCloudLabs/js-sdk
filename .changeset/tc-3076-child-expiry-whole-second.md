---
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
---

A session or delegation made under a parent that expires on a fractional second now ends at the parent's whole second. `useDelegation` activates its session, `createSubDelegation` defaults and caps its delegation, and `grantRuntimePermissions` ends its grants at the session, each rounded down to the whole second, so a node that reads the parent's expiry in whole seconds accepts them (it refused them as outliving the parent). A delegation with less than a second left is refused with a clear message.

Details: TC-3076
