---
"@tinycloud/web-sdk": patch
"@tinycloud/node-sdk": patch
---

`requestPermissions` on an OpenKey session signs the runtime grant through the OpenKey client the session was established with, so the Delegations tab's "Allow delegation list" completes. `grantRuntimePermissions` accepts `signMessage` to sign the prepared SIWE in place of the connected signer, and refuses a signature that does not recover to the session's account.

The permission prompt for `tinycloud.delegation/list` shows OpenKey's label and sentence for reading the delegation list, and the "Delegation" service name for other delegation actions. When the panel's permission request throws, the error's name and code are written to the console and the SDK debug log; the panel text is unchanged.

Details: TC-2113
