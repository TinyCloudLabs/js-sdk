---
"@tinycloud/operations": patch
"@tinycloud/cli": patch
---

An expired stored session now asks for a new sign-in instead of looking like a node failure (TC-607). When node-sdk refuses a persisted session as expired or no longer valid (`AUTH_EXPIRED`), the operations runtime returns the new non-retryable error code `SESSION_EXPIRED` instead of a retryable `NODE_ERROR`, and the CLI reports `AUTH_REQUIRED` (exit 3) with a sign-in hint for every profile kind. This covers `tc secrets get/list/put/delete` and every other command that restores a stored session; the refusal happens before any node request. Operations and MCP consumers that switch on error codes see `SESSION_EXPIRED` where they previously saw `NODE_ERROR` for this case.

Interactive secret escalation and `tc auth request --grant` now send OpenKey `/delegate` a request it signs (TC-609). Each request adds `tinycloud.capabilities/read` on its space root, keeps raw decrypt in the `encryption` pseudo-space, and anchors a decrypt-only request in the secrets space (`--space` when given) or, for `auth request --grant`, the profile's primary space. Previously OpenKey refused every escalation without `capabilities/read`, and a decrypt-only escalation crashed before reaching OpenKey. The signed proof is still verified before anything is activated or stored; the added `capabilities/read` counts as requested, and any other authority beyond the request is refused.
