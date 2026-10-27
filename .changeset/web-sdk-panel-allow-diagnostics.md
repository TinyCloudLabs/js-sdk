---
"@tinycloud/web-sdk": patch
"@tinycloud/node-sdk": patch
---

`requestPermissions` on an OpenKey session signs the runtime grant through the OpenKey client the session was established with, so the Delegations tab's "Allow delegation list" completes. New `TinyCloudWeb.setRuntimePermissionSigner(signer?)` sets a signer for runtime permission grants only, for apps whose sign-in is not the SDK's OpenKey flow; sign-out, a new sign-in, a restore or a session for another account clear it. `grantRuntimePermissions` accepts `signMessage` to sign the prepared SIWE in place of the connected signer, and refuses a message that is not in canonical form, or a signature that does not recover to the session's account from the exact message bytes.

The permission prompt for `tinycloud.delegation/list` shows OpenKey's label and sentence for reading the delegation list; other delegation actions read "Manage your delegations (action)". When the panel's permission request throws, the error's name and code are written to the console and the SDK debug log; the panel text is unchanged.

Details: TC-2113
