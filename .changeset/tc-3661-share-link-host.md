---
"@tinycloud/sdk-core": patch
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
---

A share link's host is used when the owner has no registry record and the host is a known TinyCloud node: a production node, or a host the recipient configured (`host`, `newUserHost` or `tinycloudFallbackHosts`). Share links to owners without a registry record open from recipients that have no `newUserHost`, including `TinyCloudWeb.receiveShare`. The owner's registry record decides whenever it exists, and v2 shares and receives that delegate to the current session don't use the link host. `@tinycloud/sdk-core` exports `isKnownTinyCloudNode`, and `SharingService` takes an optional `receivedHostHintTransport` callback that `TinyCloudNode` supplies.

Details: TC-3661
