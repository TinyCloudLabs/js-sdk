---
"@tinycloud/cli": patch
---

When a peer's owner revokes the access they gave you, Courier marks that peer as revoked, skips it and keeps syncing your other peers. Sync doesn't stop on that peer's refusal. Other sign-in refusals behave the same.

Details: TC-4329
