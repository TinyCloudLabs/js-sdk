---
"@tinycloud/operations": patch
---

Operation authority checks now judge each required capability against every grant in its owner-exact space together. A session restored from an OpenKey signed login reports one grant per signed action, so an operation needing `tinycloud.kv/get` and `tinycloud.kv/list` on one path was reported as `authority_required` even though both actions were signed.

`tinycloud.auth.import` now stores, with each delegation, the request it was checked against. A signed-login (CACAO) delegation replays only when that binding is present and the delegation fits inside the bound request, using the same validation and containment check as import, so whatever import stores, the next runtime installs. Re-importing a signed-login delegation that is already stored without a binding, against a request it fits, adds the binding. The binding is local profile data: it stops records written by any other path (a CLI import of an unbound artifact, a copied or pasted record) from granting authority, but not someone who can write the profile directory, who already holds the session key and the signed bytes. Compact UCAN records and their replay are unchanged.
