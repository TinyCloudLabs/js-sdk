---
"@tinycloud/cli": patch
---

`tc share publish --json` now reports the sender-history write as `history`: `{"recorded": true}`, or `{"recorded": false, "reason": "HISTORY_UNREADABLE" | "HISTORY_WRITE_FAILED" | "HISTORY_UNAVAILABLE"}`. The exit status stays 0. The stderr warning names the reason and the share id and CID to keep, and a failed delivery-confirmation write on `share notify` now names its reason too.
