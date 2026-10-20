---
"@tinycloud/courier": patch
"@tinycloud/cli": patch
---

Keep broker configuration outside Courier and resolve the owner's gh credential at runtime without copying it. Woken agents use a separate home and Courier-only identity snapshot. Existing broker token files are no longer used; owners configure the broker again after signing in with gh.

Refuse protected-root traversal, gated executable aliases/copies, local network destinations and the remaining reviewed GitHub, registry and credential access variants. This is a policy layer; dedicated OS users remain the credential boundary.
