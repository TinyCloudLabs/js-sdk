---
"@tinycloud/cli": patch
---

Restore production email credential defaults for exact-email share publication without credential flags. Preserve independent overrides, the canonical email profile's existing trust pins, and path-bound Policy/v3 registration; reject malformed overrides before publication requests.

Details: TC-2202
