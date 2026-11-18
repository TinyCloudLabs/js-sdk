---
"@tinycloud/sdk-core": patch
---

A share link no longer carries `tinycloud.delegation` actions, so whoever holds a link can't revoke, create, list or renew delegations with it. Both `sharing.generate` and the child delegation a recipient creates from a received link (`delegateReceivedShare`, and `receive` when it sub-delegates) now refuse any `tinycloud.delegation/*` action with `INVALID_INPUT`. They refuse before anything is signed or sent. Read, list and edit shares are unchanged. Details: TC-3286
