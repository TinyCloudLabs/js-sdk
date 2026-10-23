---
"@tinycloud/cli": patch
---

A manifest, grant or login permission that carries a limit (any `caveats` other than absent, `[]` or `[{}]`) is refused with `CAVEATS_UNSUPPORTED` (exit 2) before any OpenKey URL, device authorization or request is made. The check uses the same `recapCaveatsEqual` comparison as the SDK.

Details: TC-1856
