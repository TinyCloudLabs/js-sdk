---
"@tinycloud/replica": patch
---

Add profile and browser replica lifecycle gates with strict persisted-stamp validation, origin-wide denial tombstones, mandatory serialization, private browser HMAC/account keys, and seven-day consent crypto-shredding. Browser denial records opaque purge intents, erases device/install anchors, and preserves the deny floor through database deletion and v1 migration. A refused replica stamp no longer rejects a valid Node network-session restore; replication remains gated.
