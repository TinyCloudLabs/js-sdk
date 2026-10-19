---
"@tinycloud/replica": patch
---

Add profile and browser replica lifecycle gates with strict persisted-stamp validation, origin-wide denial tombstones, mandatory serialization, private browser HMAC/account keys, and seven-day consent crypto-shredding. Browser denial records opaque purge intents, erases device/install anchors and their reserved quota usage, and preserves the deny floor through database deletion and v1 migration. Node gate mutations require a caller-supplied profile lock; denial advances pending-write generations with intents in one durable gate-file update. A refused replica stamp no longer rejects a valid network sign-in or restore; replication remains gated.

Node deferred sign-out records complete opaque purge intents and pending generations with an `eraseDeferred` gate marker in the same atomic profile-file rewrite. Ordinary recovery does not erase deferred files; a profile-locked epoch/principal token clears the marker before idempotent replay. A successor account cannot reuse the token.

The signed WASM SIWE generator preserves millisecond `Issued At` precision. Post-deny establishment requires that timestamp to be strictly later than `deniedAt`; externally generated second-precision SIWE can be refused within the same second and needs a newly signed SIWE after the next second.

Browser startup recovery passes its abort signal to the origin Web Lock request. Aborting while queued reports unfinished recovery without changing the gate or encryption keys, allowing network sessions to continue with local replication gated.
