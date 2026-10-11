---
"@tinycloud/operations": patch
---

Operation authority checks now judge each required capability against every grant in its owner-exact space together. A session restored from an OpenKey signed login reports one grant per signed action, so an operation needing `tinycloud.kv/get` and `tinycloud.kv/list` on one path was reported as `authority_required` even though both actions were signed.

`tinycloud.auth.import` stores the request binding with every validated delegation and replaces any older row for the same CID. The verified replay policy checks signed-login and compact UCAN delegations against that binding before installation. CLI imports and grants can also synthesize bindings limited to their own verified signed capabilities; the binding is local profile data, not protection against an attacker who controls the profile directory and session key.
