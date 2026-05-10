---
"@tinycloud/node-sdk": minor
"@tinycloud/cli": patch
---

Fix `restoreSession` so runtime-permission-grant operations work after
session restore (notably the OpenKey-backed CLI path).

`TinyCloudNode.restoreSession` populated `_serviceContext.session` (the
`ServiceSession` used by service invokers) but never set
`auth.tinyCloudSession` (the richer `TinyCloudSession` that surfaces the
SIWE recap, address, chain, etc.). Methods that read from the latter —
`hasRuntimePermissions`, `getRuntimePermissionDelegations`,
`useRuntimeDelegation`, `grantRuntimePermissions` — therefore threw
`SessionExpiredError(new Date(0))` immediately after every restore.

Symptoms:
- `tc auth request --cap …` fails with `Session expired at 1970-01-01T00:00:00.000Z`
- Persisted runtime delegations replayed via `useRuntimeDelegation` are
  rejected, so `tc auth caps` reports `granted: []` even when
  `additional-delegations.json` has live entries.

Changes:
- `restoreSession` now accepts optional `siwe` and `signature` fields.
- When `siwe` + `address` + `chainId` are provided, a full
  `TinyCloudSession` is rehydrated. In wallet mode it lands on
  `auth.tinyCloudSession` via the new
  `NodeUserAuthorization.setRestoredTinyCloudSession`. In session-only
  mode (no auth layer — typical for OpenKey-restored CLIs) it lands on
  a new `TinyCloudNode._restoredTcSession` field.
- A new private `currentTinyCloudSession()` helper resolves the active
  session from either surface. The four runtime-permission readers
  (`hasRuntimePermissions`, `getRuntimePermissionDelegations`,
  `useRuntimeDelegation`, `grantRuntimePermissions`) now consult it.

CLI side (`@tinycloud/cli`): `replayAdditionalDelegations` exposes a
`TC_DEBUG_REPLAY=1` env switch that prints which stored delegations
fail to install and why. Useful for diagnosing future restore-related
issues.

Backwards compatible: `restoreSession`'s new parameters are optional;
old callers continue to work, they just don't get runtime-grant
support until they pass `siwe`. The CLI was already passing `siwe` —
the SDK was just dropping it.
