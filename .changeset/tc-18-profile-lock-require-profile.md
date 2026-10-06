---
"@tinycloud/operations": patch
---

`withProfileLock` takes `requireProfile: true` for writers of state that lives inside an existing profile (TC-18 replicas): the lock is taken only while the profile's `profile.json` exists, checked before and after waiting for its turn, and never creates the profile directory. A missing or deleted profile is refused with `ProfileDeletedError` (`PROFILE_NOT_FOUND`), and an empty directory a deletion left behind is removed. Without the option the lock behaves as before.
