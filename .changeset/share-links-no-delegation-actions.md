---
"@tinycloud/sdk-core": patch
---

A share link no longer carries `tinycloud.delegation` actions, so whoever holds a link can't revoke, create, list or renew delegations with it. `sharing.generate`, and `delegateReceivedShare` (or `receive` when it sub-delegates) for a received link, now refuse any `tinycloud.delegation/*` action with `INVALID_INPUT`, before anything is signed or sent. `sharing.preflightGenerate` reports such a link as `"not-covered"`, so it never says `"ok"` for a link `generate` refuses. Read, list and edit shares are unchanged.

Details: TC-3286
