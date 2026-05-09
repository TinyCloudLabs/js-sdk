---
"@tinycloud/node-sdk": minor
"@tinycloud/cli": minor
---

Default delegation lifetime bumped to 7 days; default session lifetime
bumped to 7 days; CLI gains `tc auth request --expiry`.

Why: 1-hour grants forced agent workflows to re-prompt the user for caps
they had already approved on every CLI invocation past the first hour.
The session itself defaulted to 1 hour too, so even an explicit
`--expiry 30d` couldn't outlive its parent. Both defaults moved to 7
days so the common agent loop runs unattended for a week.

- `delegateToHelpers.resolveExpiryMs(undefined)` now returns
  `DEFAULT_DELEGATION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000`.
- `TinyCloudNodeConfig.sessionExpirationMs` default is now
  `DEFAULT_SESSION_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000`. Existing
  callers passing an explicit value are unaffected. Wallet-mode SIWE
  sessions cap at 1 hour by protocol — that limit is independent of
  this default.
- `tc auth request --expiry <duration>` accepts a ms-format string
  (`"7d"`, `"30m"`) or raw millisecond integer. Forwarded to
  `node.grantRuntimePermissions(permissions, { expiry })` for the
  local-key path and encoded into the OpenKey `/delegate?expiry=...`
  URL parameter for the OpenKey path. OpenKey-side support landed
  separately in TinyCloudLabs/openkey.
