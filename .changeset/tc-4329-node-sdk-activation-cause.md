---
"@tinycloud/node-sdk": patch
---

`RuntimeDelegationRejectedError` from a delegation activation carries the node's response (HTTP status and body) as its `cause`, so callers can inspect it without parsing the message. Reason codes and messages are the same.

Details: TC-4329
