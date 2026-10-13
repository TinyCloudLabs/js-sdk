---
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
---

Repeat Node and CLI sign-ins no longer re-run the full account bootstrap (TC-999). On Node, the bootstrap completion marker was stored as `text/plain` and read back as a string, so it was rejected and every login ran the repair (about 53 s on production). A string marker is now parsed as JSON before validation; invalid JSON or a marker of the wrong shape still means "not completed" and never throws. Markers already written as `text/plain` are accepted, so existing accounts skip on their next sign-in.
