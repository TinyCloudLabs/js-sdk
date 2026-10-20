---
"@tinycloud/cli": patch
---

`tc share publish --json` now reports the sender-history write as `history`: `{"recorded": true}`, or `{"recorded": false, "reason": "HISTORY_UNREADABLE" | "HISTORY_READ_FAILED" | "HISTORY_WRITE_FAILED" | "HISTORY_UNAVAILABLE"}`. The exit status stays 0. The stderr warning names the reason. When a publish with `--notify` delivers but its confirmation cannot be saved, the warning also names the share id and CID to keep, and `history` stays `{"recorded": true}`. A failed delivery-confirmation write on `share notify` names its reason too.
