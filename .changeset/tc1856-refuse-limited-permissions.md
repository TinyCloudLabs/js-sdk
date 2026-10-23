---
"@tinycloud/cli": patch
---

A manifest, grant or login permission that carries a limit (a non-empty `caveats` entry) is refused with `CAVEATS_UNSUPPORTED` (exit 2) before any OpenKey URL, device authorization or request is made. Absent, `[]`, `[{}]` and `[{},{}]` caveats are unchanged.

Details: TC-1856
