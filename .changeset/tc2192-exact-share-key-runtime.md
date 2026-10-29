---
"@tinycloud/sdk-core": patch
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
---

Allow explicit runtime permission requests to create one exact `share/<id>` named key on the current owner's default encryption network. Validate the owner, resource and action before consent, bind approval to the same signed session, and activate only the requested key-create authority. Native shells without a supported permission-request path refuse rather than falling back to a web signer. Static manifests and native authority ceilings are unchanged.

Keep runtime permission approval bound to the captured session key through signing and activation.

Details: TC-2192
