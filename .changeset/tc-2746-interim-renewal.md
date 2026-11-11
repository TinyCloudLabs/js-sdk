---
"@tinycloud/courier": patch
---

Courier now renews its own paired-peer read access while the existing access and owner approval are still live, for up to 30 days within the owner's approved end date. It checks issued grants for revocation before signing, preserves the same peer and permissions, and requests one owner approval before its own access expires.

To stop sharing, revoke the pairing. An already published renewal can remain usable until Courier next runs, and never beyond its own end date (at most 30 days). Expired or revoked access requires a new pairing.

Details:

- TC-2746
