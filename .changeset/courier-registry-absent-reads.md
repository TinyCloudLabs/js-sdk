---
"@tinycloud/courier": patch
---

Courier keeps only a confirmed absence from the location registry, and only for reads. An owner with a registry record is looked up again before every node call, and every write (send, delivery, pause and resume notices, tasks, requests, pairing) looks its owner up before it runs. Reads of an owner with no registry record still share one lookup per minute in a process, so `read`, `inbox` and an idle `watch` pass keep their lower registry traffic. A removed or changed registration is seen on the next call.

Details: TC-2481, TC-2970
