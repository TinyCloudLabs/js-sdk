---
"@tinycloud/operations": patch
---

Operation authority checks now judge each required capability against every grant in its owner-exact space together. A session restored from an OpenKey signed login reports one grant per signed action, so an operation needing `tinycloud.kv/get` and `tinycloud.kv/list` on one path was reported as `authority_required` even though both actions were signed.

`tinycloud.auth.import` now stores the request each delegation was checked against with the delegation. A signed-login (CACAO) delegation replays only if that binding is present and the delegation still fits inside the bound request; otherwise it grants nothing. Compact UCAN replay is unchanged.
