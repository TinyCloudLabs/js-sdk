---
"@tinycloud/replica": patch
---

Add the profile gate file (`profile-gate`) and browser lifecycle gate: sign-in stamp, restore validation, deny, and ordered purge with startup recovery. Browser denial now survives IndexedDB deletion through an origin-wide `localStorage` tombstone, refuses missing Web Locks, and clears durable grant-install anchors for denied identities.
