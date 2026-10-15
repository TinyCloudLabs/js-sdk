---
"@tinycloud/replica": patch
---

Add profile and browser replica lifecycle gates with strict persisted-stamp validation, origin-wide denial tombstones, mandatory serialization, private browser HMAC/account keys, and seven-day consent crypto-shredding. Browser denial records opaque purge intents, erases device/install anchors and their reserved quota usage, and preserves the deny floor through database deletion and v1 migration. Node gate mutations require a caller-supplied profile lock; denial advances pending-write generations with intents in one durable gate-file update. A refused replica stamp no longer rejects a valid network sign-in or restore; replication remains gated.

The signed WASM SIWE generator preserves millisecond `Issued At` precision. Post-deny establishment requires that timestamp to be strictly later than `deniedAt`; externally generated second-precision SIWE can be refused within the same second and needs a newly signed SIWE after the next second.
