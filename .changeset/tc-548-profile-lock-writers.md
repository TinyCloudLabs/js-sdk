---
"@tinycloud/cli": patch
"@tinycloud/operations": patch
---

Bring the remaining profile writers under the profile lock. `tc profile delete` waits for the lock and removes the profile's files while holding it, never another holder's lock, and rejects names that are not a single path segment. Local `tc auth rotate` keeps the previous session when a concurrent change refuses its commit (`PROFILE_CHANGED_DURING_LOGIN`). A failed `tc auth import` rolls back its delegate-session bootstrap only if the profile still holds what the bootstrap wrote, and keeps (and reports) newer state otherwise; the bootstrap reads the profile, key and session under the lock and never replaces a session that appeared meanwhile (`PROFILE_CHANGED_DURING_IMPORT`). A writer waiting while a profile is deleted recreates the profile directory instead of failing.
