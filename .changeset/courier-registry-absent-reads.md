---
"@tinycloud/courier": patch
---

Courier keeps only a confirmed absence from the location registry, and only plain data reads use it. Reads of an owner with no registry record share one lookup per minute in a process, so `read`, `inbox` and an idle `watch` pass keep their lower registry traffic. Everything else looks the owner up when it runs:
- each write to a space (send, `watch` and `intake` imports, mirrors, receipts and state, `outbox serve`, pause and resume notices, tasks, requests, pairing);
- installing a peer's grant;
- an owner with a registry record, before every call.

A removed or changed registration is seen on the next such call.

Details: TC-2481, TC-2970
