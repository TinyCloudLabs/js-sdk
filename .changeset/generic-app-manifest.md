---
"@tinycloud/server": minor
---

A sign-in that declares no `manifest`, `capabilityRequest` or `defaultActions` asks only for the app's own folder: KV (get, put, del, list, metadata) and SQL (read, write) under `applications/<app id>/`, plus capabilities read on `applications`, for 7 days. The app id is the sign-in domain reversed (`notes.example.com` → `com.example.notes`), or `node.app` for a Node client without a `domain`. It doesn't get the whole primary space, the secrets vault, account registry entries, the public space or the encryption network, and it logs one console warning per sign-in. `@tinycloud/server`'s `createServerIdentity` without a `manifest` gets the same folder.

Sessions, app delegations and bootstrap sessions default to 7 days, with or without a manifest. A manifest's `expiry` doesn't set the session length; set `sessionExpirationMs` for a longer session.

Upgrading: the default was 30 days. Apps that relied on it, including apps with a manifest such as Share's library sign-in, set `sessionExpirationMs` to keep 30 days.

Owner tools that need every action on their own space pass `...ownerFullAccess(space)` (new, from `@tinycloud/sdk-core` and `@tinycloud/node-sdk`) in the `TinyCloudNode` config; `defaultActions` is a `TinyCloudNode` option.

A wallet-mode `TinyCloudNode` runs its calls on its own session from the first sign-in: the sessions it signs to set up a new account are used only for that setup, so the manifest bounds what the app can do.

`createEncryptionNetwork` returns a network that already exists without asking to create it, so calling it for the network account setup created needs no `network.create` in the manifest.

Details: TC-3443
