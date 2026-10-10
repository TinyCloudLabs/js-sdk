---
"@tinycloud/node-sdk": patch
"@tinycloud/operations": patch
"@tinycloud/cli": patch
---

A SIWE-less session created by `tc auth import` now expires locally at the compact UCAN's signed `exp`; expired restores throw `AUTH_EXPIRED` before host lookup, including sessions imported by earlier releases. The new `signedCompactUcanExpiry` export reads that signed lifetime. CACAO-headed sessions remain refused only by the node.

Importing an already-expired compact delegation, or one that expires before activation, reports `DELEGATION_EXPIRED` and stores no delegation. If a fresh delegate profile's provisional session expires during import, it is rolled back unless another writer has since changed the profile. Operations and MCP return non-retryable `AUTH_REQUIRED` for an expired stored session; activation expiry now reports `DELEGATION_EXPIRED` instead of `DELEGATION_REJECTED`, including through MCP `tinycloud_auth_import`.

The client clock is authoritative. `context` reports imported-session expiry, and the scoped paste login named by the hint is no longer blocked by an unknown expiry. Before probing a configured local node, session-using commands verify the stored session locally; this also covers older imported sessions. Login, logout, rotate, status, whoami, context, node, profile, `space host-request|switch`, `enable`, `auth request` without `--grant`, explicit private-key commands, and profiles without a stored session retain discovery behavior. Deferred discovery after owner refresh respects a context copied with another host.
