---
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": minor
"@tinycloud/web-sdk": minor
"@tinycloud/bootstrap": minor
"@tinycloud/server": minor
---

A sign-in that declares no `manifest`, `capabilityRequest` or `defaultActions` now asks only for the app's own folder: KV (get, put, del, list, metadata) and SQL (read, write) under `applications/<app id>/`, plus capabilities read on `applications`, for 7 days. The app id is the sign-in domain reversed (`notes.example.com` → `com.example.notes`), or `node.app` for a Node client without a `domain`. It no longer gets the whole primary space, the secrets vault, account registry entries, the public space or the encryption network, and it logs one console warning per sign-in. `@tinycloud/server`'s `createServerIdentity` without a `manifest` gets the same folder.

Sessions, app delegations and bootstrap sessions now default to 7 days instead of 30.

Owner tools that need every action on their own space pass `...ownerFullAccess(space)` (new, from `@tinycloud/sdk-core` and `@tinycloud/node-sdk`) in the `TinyCloudNode` config; `defaultActions` is now a `TinyCloudNode` option.

A wallet-mode `TinyCloudNode` now runs its calls on its own session from the first sign-in: the sessions it signs to set up a new account are used only for that setup, so the manifest bounds what the app can do.

`createEncryptionNetwork` returns a network that already exists instead of asking to create it again, so calling it for the network account setup created needs no `network.create` in the manifest.

Details: TC-3443
