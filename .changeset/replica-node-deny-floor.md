---
"@tinycloud/replica": patch
---

The Node profile gate keeps a durable deny floor (`replica-deny-floor.json`) beside `replica-gate.json`. After a sign-out, a missing gate file is no longer silently recreated, and a gate behind the floor fails closed with `gate_unavailable`.
