---
"@tinycloud/share-envelope": minor
---

Add immutable, signed OpenKey approval-request links using the shared `/a/<id>#v=4&k=<key>&c=<sealedBodyCid>` grammar. Requests default to one hour, are capped at 24 hours, and use repeatable non-consuming reads. Validate the sealed issuer, target Ed25519 key, and P-256 result encryption key without changing existing login, share, or courier links.

Details: TC-2212
